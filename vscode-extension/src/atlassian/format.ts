/**
 * Turning Atlassian payloads into text an agent can read.
 *
 * Three shapes need flattening before they are useful in an MCP response:
 *
 *   - Confluence storage format — XHTML with `ac:`/`ri:` macro elements.
 *   - Jira Cloud descriptions and comments — ADF (Atlassian Document Format)
 *     JSON node trees.
 *   - Jira Server/DC descriptions — wiki markup, already plain enough to pass
 *     through untouched.
 *
 * The goal is readable, compact text, not a faithful Markdown conversion: the
 * agent needs the content and its structure, and every extra character is
 * budget it spends on something else.
 */

/** Longest single field we hand back before truncating with a visible note. */
export const DEFAULT_MAX_BODY_CHARACTERS = 12_000;

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = HTML_ENTITIES[entity.toLowerCase()];
    return named ?? match;
  });
}

/**
 * Flatten Confluence storage XHTML into text.
 *
 * Block elements become newlines, list items get a `- ` marker, headings get
 * their `#` markers, and `ac:` macros are reduced to their body text (a macro
 * usually wraps content the reader still wants — a code block, a note panel —
 * so dropping the whole element would lose real information). Anything left
 * over is stripped as markup.
 */
export function storageToText(storage: string): string {
  let text = storage;

  // Drop content that carries no reader-visible text.
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Structured macro parameters are configuration, not content.
  text = text.replace(/<ac:parameter\b[^>]*>[\s\S]*?<\/ac:parameter>/gi, '');
  // Link/attachment references keep only their human-readable target.
  text = text.replace(/<ri:[a-z-]+\b([^>]*)\/?>/gi, (_match, attributes: string) => {
    const title = /ri:(?:content-title|filename|value)="([^"]*)"/i.exec(attributes);
    return title?.[1] ?? '';
  });

  text = text.replace(/<h([1-6])\b[^>]*>/gi, (_match, level: string) => {
    return `\n\n${'#'.repeat(Number(level))} `;
  });
  text = text.replace(/<\/h[1-6]>/gi, '\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(
    // `</li>` is deliberately absent: `<li>` already opens its own line, and
    // closing it too would put a blank line between every list item.
    /<\/(p|div|tr|table|ul|ol|blockquote|ac:structured-macro|ac:rich-text-body|ac:plain-text-body)>/gi,
    '\n',
  );
  text = text.replace(/<\/(td|th)>/gi, ' | ');

  // Everything else is markup we do not need.
  text = text.replace(/<[^>]+>/g, '');
  text = decodeHtmlEntities(text);

  return collapseBlankLines(text);
}

/** Collapse runs of blank lines and trailing spaces left behind by stripping. */
export function collapseBlankLines(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

/**
 * Render a Jira text field. Server/DC returns a string (wiki markup); Cloud
 * returns an ADF node tree. Anything unrecognised becomes an empty string so a
 * schema change never crashes a tool call.
 */
export function renderJiraText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return collapseBlankLines(value);
  if (typeof value === 'object') return collapseBlankLines(adfToText(value));
  return '';
}

/**
 * Flatten an ADF document. Only the node types that carry text or structure
 * are special-cased; unknown nodes still recurse into `content`, so a new
 * Atlassian node type degrades to its inner text rather than disappearing.
 */
export function adfToText(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (Array.isArray(node)) return node.map(adfToText).join('');
  if (typeof node !== 'object') return String(node);

  const adf = node as {
    type?: string;
    text?: string;
    content?: unknown;
    attrs?: Record<string, unknown>;
  };

  switch (adf.type) {
    case 'text':
      return adf.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'paragraph':
    case 'heading':
    case 'blockquote':
    case 'codeBlock':
    case 'panel':
    case 'tableRow':
      return `${adfToText(adf.content)}\n`;
    case 'listItem':
      return `- ${adfToText(adf.content).trim()}\n`;
    case 'tableCell':
    case 'tableHeader':
      return `${adfToText(adf.content).trim()} | `;
    case 'mention':
      return `@${String(adf.attrs?.text ?? adf.attrs?.id ?? '')}`.replace(/^@@/, '@');
    case 'emoji':
      return String(adf.attrs?.shortName ?? '');
    case 'inlineCard':
    case 'blockCard':
      return String(adf.attrs?.url ?? '');
    case 'mediaSingle':
    case 'media':
      return '';
    default:
      return adfToText(adf.content);
  }
}

/**
 * Clip a field and say so. A silent cut looks like the document simply ended,
 * which sends the agent off reading files to fill a gap that is not there.
 */
export function truncate(
  text: string,
  maxCharacters: number = DEFAULT_MAX_BODY_CHARACTERS,
): string {
  if (text.length <= maxCharacters) return text;
  const kept = text.slice(0, maxCharacters);
  const removed = text.length - maxCharacters;
  return `${kept}\n\n… truncated ${removed.toLocaleString('en-US')} more characters. Request a narrower section or a specific page id for the rest.`;
}

/** Compact ISO timestamp: `2026-08-24 09:31`. Empty string for junk input. */
export function formatTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().replace('T', ' ').slice(0, 16);
}

/**
 * Escape a user string for embedding in a quoted JQL/CQL literal.
 *
 * Both languages take double-quoted strings with backslash escapes, so a
 * query containing `"` or `\` would otherwise change the meaning of the
 * generated clause.
 */
export function quoteQueryLiteral(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}
