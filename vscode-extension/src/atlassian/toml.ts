/**
 * Just enough TOML to inject, replace, or remove a single dotted-key table
 * (`[mcp_servers.codebrain-atlassian]`) inside an existing `~/.codex/config.toml`.
 *
 * Deliberately not a general parser: everything outside the target block is
 * preserved byte-for-byte, so a user's other MCP servers, model settings and
 * comments survive an install / uninstall round-trip. Ported from the
 * codegraph installer, where this approach has covered the same file for
 * several releases.
 *
 * The small lexical scan exists because a value may legally span lines — a
 * multiline string or a nested array containing `[...]` must not be mistaken
 * for the start of a sibling table.
 */

type TomlValue = string | string[] | Record<string, string>;

/**
 * Serialize a record into the body lines of a TOML table. Strings, string
 * arrays, and flat string maps (written as inline tables) are supported —
 * an MCP server entry needs nothing else.
 */
export function serializeTomlTableBody(values: Record<string, TomlValue>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      lines.push(`${key} = ${quoteString(value)}`);
    } else if (Array.isArray(value)) {
      lines.push(`${key} = [${value.map(quoteString).join(', ')}]`);
    } else {
      const pairs = Object.entries(value).map(
        ([name, item]) => `${name} = ${quoteString(item)}`,
      );
      lines.push(`${key} = { ${pairs.join(', ')} }`);
    }
  }
  return lines.join('\n');
}

function quoteString(value: string): string {
  // TOML basic strings: escape backslash and double quote. Control characters
  // are not expected in a command, an argument, or a URL.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Header line + body, ready to splice into a file. */
export function buildTomlTable(
  header: string,
  values: Record<string, TomlValue>,
): string {
  return `[${header}]\n${serializeTomlTableBody(values)}`;
}

/**
 * Insert or replace a top-level dotted-key table. `'unchanged'` means the
 * existing block already matched byte-for-byte, which is what makes a
 * re-install a no-op.
 */
export function upsertTomlTable(
  fileContent: string,
  header: string,
  block: string,
): { content: string; action: 'inserted' | 'replaced' | 'unchanged' } {
  const headerLine = `[${header}]`;
  const headerIndex = findHeaderIndex(fileContent, headerLine);

  if (headerIndex === -1) {
    const trimmed = fileContent.trimEnd();
    const separator = trimmed.length > 0 ? '\n\n' : '';
    return { content: `${trimmed}${separator}${block}\n`, action: 'inserted' };
  }

  const blockEnd = findNextTableHeader(fileContent, headerIndex + headerLine.length);
  const existing = fileContent.substring(headerIndex, blockEnd).replace(/\n+$/, '');
  if (existing === block) return { content: fileContent, action: 'unchanged' };

  const before = fileContent.substring(0, headerIndex).replace(/\n+$/, '');
  const after = fileContent.substring(blockEnd).replace(/^\n+/, '');
  const separatorBefore = before.length > 0 ? '\n\n' : '';
  const separatorAfter = after.length > 0 ? '\n\n' : '\n';
  return {
    content: before + separatorBefore + block + separatorAfter + after,
    action: 'replaced',
  };
}

/** Remove a top-level dotted-key table block. */
export function removeTomlTable(
  fileContent: string,
  header: string,
): { content: string; action: 'removed' | 'not-found' } {
  const headerLine = `[${header}]`;
  const headerIndex = findHeaderIndex(fileContent, headerLine);
  if (headerIndex === -1) return { content: fileContent, action: 'not-found' };

  const blockEnd = findNextTableHeader(fileContent, headerIndex + headerLine.length);
  const before = fileContent.substring(0, headerIndex).replace(/\n+$/, '');
  const after = fileContent.substring(blockEnd).replace(/^\n+/, '');
  return {
    content: before + (before && after ? '\n\n' : '') + after,
    action: 'removed',
  };
}

/** Byte index of a header line at the start of a line, or -1. */
function findHeaderIndex(content: string, headerLine: string): number {
  if (content.startsWith(headerLine)) return 0;
  const index = content.indexOf(`\n${headerLine}`);
  return index === -1 ? -1 : index + 1;
}

/** Byte index of the next `[...]`/`[[...]]` header after `from`, else EOF. */
function findNextTableHeader(content: string, from: number): number {
  const state: TomlLexState = {
    multilineString: null,
    arrayDepth: 0,
    inlineTableDepth: 0,
  };
  let lineStart = from;
  let isHeaderRemainder = true;

  while (lineStart < content.length) {
    const newlineIndex = content.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? content.length : newlineIndex;
    const line = content.slice(lineStart, lineEnd);

    if (
      !isHeaderRemainder &&
      state.multilineString === null &&
      state.arrayDepth === 0 &&
      state.inlineTableDepth === 0 &&
      TOML_TABLE_HEADER.test(line)
    ) {
      return lineStart;
    }

    scanTomlLine(line, state);
    if (newlineIndex === -1) break;
    lineStart = newlineIndex + 1;
    isHeaderRemainder = false;
  }

  return content.length;
}

type MultilineStringDelimiter = '"""' | "'''";

interface TomlLexState {
  multilineString: MultilineStringDelimiter | null;
  arrayDepth: number;
  inlineTableDepth: number;
}

const TOML_KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*')`;
const TOML_DOTTED_KEY = String.raw`${TOML_KEY_PART}(?:[ \t]*\.[ \t]*${TOML_KEY_PART})*`;
const TOML_TABLE = String.raw`\[[ \t]*${TOML_DOTTED_KEY}[ \t]*\]`;
const TOML_ARRAY_TABLE = String.raw`\[\[[ \t]*${TOML_DOTTED_KEY}[ \t]*\]\]`;
const TOML_TABLE_HEADER = new RegExp(
  String.raw`^[ \t]*(?:${TOML_TABLE}|${TOML_ARRAY_TABLE})[ \t]*(?:#.*)?\r?$`,
);

/**
 * Track value constructs that may span lines, so bracket-shaped string content
 * and nested arrays are never mistaken for a sibling table header.
 */
function scanTomlLine(line: string, state: TomlLexState): void {
  for (let i = 0; i < line.length; ) {
    if (state.multilineString !== null) {
      const end = findMultilineStringEnd(line, i, state.multilineString);
      if (end === -1) return;
      i = end + state.multilineString.length;
      state.multilineString = null;
      continue;
    }

    if (line[i] === '#') return;

    const multiline = line.startsWith('"""', i)
      ? '"""'
      : line.startsWith("'''", i)
        ? "'''"
        : null;
    if (multiline !== null) {
      state.multilineString = multiline;
      i += multiline.length;
      continue;
    }

    const char = line[i]!;
    if (char === '"' || char === "'") {
      i = skipSingleLineString(line, i, char);
      continue;
    }
    if (char === '[') state.arrayDepth++;
    else if (char === ']' && state.arrayDepth > 0) state.arrayDepth--;
    else if (char === '{') state.inlineTableDepth++;
    else if (char === '}' && state.inlineTableDepth > 0) state.inlineTableDepth--;
    i++;
  }
}

function findMultilineStringEnd(
  line: string,
  from: number,
  delimiter: MultilineStringDelimiter,
): number {
  let end = line.indexOf(delimiter, from);
  while (delimiter === '"""' && end !== -1 && isBackslashEscaped(line, end)) {
    end = line.indexOf(delimiter, end + 1);
  }
  return end;
}

function isBackslashEscaped(line: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && line[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

function skipSingleLineString(line: string, start: number, quote: '"' | "'"): number {
  for (let i = start + 1; i < line.length; i++) {
    if (quote === '"' && line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] === quote) return i + 1;
  }
  return line.length;
}
