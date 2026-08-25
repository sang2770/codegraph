/**
 * Inserting, replacing and removing one marker-delimited section inside a
 * Markdown file the user also owns.
 *
 * Used for the agents that have no skill mechanism of their own, where the only
 * way to ship guidance is to append it to an instructions file (`GEMINI.md`,
 * `.github/copilot-instructions.md`). Everything outside the markers is
 * preserved byte-for-byte, so a user's own instructions survive an install /
 * uninstall round-trip, and re-installing identical content reports
 * `unchanged` rather than rewriting the file.
 */

export interface BlockUpsertResult {
  content: string;
  action: 'inserted' | 'replaced' | 'unchanged';
}

export interface BlockRemoveResult {
  content: string;
  action: 'removed' | 'not-found';
}

/** Byte offsets of the marked section, markers included. */
function locate(
  content: string,
  start: string,
  end: string,
): { from: number; to: number } | undefined {
  const from = content.indexOf(start);
  if (from === -1) return undefined;
  const closing = content.indexOf(end, from + start.length);
  // An opening marker with no closing one means the file was hand-edited into
  // a state we cannot safely rewrite — treat it as absent and append instead
  // of guessing where the user meant the section to stop.
  if (closing === -1) return undefined;
  return { from, to: closing + end.length };
}

export function readMarkdownBlock(
  content: string,
  start: string,
  end: string,
): string | undefined {
  const range = locate(content, start, end);
  return range ? content.slice(range.from, range.to) : undefined;
}

export function upsertMarkdownBlock(
  content: string,
  start: string,
  end: string,
  body: string,
): BlockUpsertResult {
  const block = `${start}\n${body.trim()}\n${end}`;
  const range = locate(content, start, end);

  if (range) {
    if (content.slice(range.from, range.to) === block) return { content, action: 'unchanged' };
    return {
      content: `${content.slice(0, range.from)}${block}${content.slice(range.to)}`,
      action: 'replaced',
    };
  }

  const existing = content.trimEnd();
  return {
    content: existing === '' ? `${block}\n` : `${existing}\n\n${block}\n`,
    action: 'inserted',
  };
}

export function removeMarkdownBlock(
  content: string,
  start: string,
  end: string,
): BlockRemoveResult {
  const range = locate(content, start, end);
  if (!range) return { content, action: 'not-found' };

  const before = content.slice(0, range.from).trimEnd();
  const after = content.slice(range.to).trimStart();
  const joined = before === '' ? after : after === '' ? `${before}\n` : `${before}\n\n${after}`;
  return { content: joined, action: 'removed' };
}
