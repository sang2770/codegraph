/**
 * Pure text extraction behind `codebrain_task_context`.
 *
 * A ticket is prose; the agent needs three structured things out of it before
 * it can work: the acceptance criteria it must satisfy, the Confluence pages
 * the ticket points at, and the code names worth handing to
 * `codegraph_explore`. All three are pulled out here, without a network call,
 * so the rules can be tested on plain strings.
 */

/** Headings that introduce a list of acceptance criteria, in English and Vietnamese. */
const CRITERIA_HEADING =
  /^\s*(?:#{1,6}\s*|h[1-6]\.\s*|\*+\s*|_+\s*)?(?:acceptance\s+criteria|\bAC\b|definition\s+of\s+done|\bDoD\b|expected\s+(?:result|behaviou?r)s?|tiêu\s+chí(?:\s+chấp\s+nhận)?|điều\s+kiện\s+(?:chấp\s+nhận|hoàn\s+thành)|kết\s+quả\s+mong\s+(?:đợi|muốn))\b[^\n]*$/iu;

/** A list item: `-`, `*`, `•`, `1.`, `1)`, `[ ]`, `[x]`, or Jira wiki `#`. */
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)]|#(?!#)|\[[ xX]\])\s+(.+)$/;

/** Given / When / Then lines count as criteria wherever they appear. */
const GHERKIN = /^\s*(?:[-*•]\s*)?(?:given|when|then|and)\b\s+(.+)$/i;

/**
 * Acceptance criteria written in a ticket description or comment.
 *
 * Looks for a criteria heading and collects the list under it, stopping at the
 * next heading or at the first non-list line after the list began. When no
 * heading exists, Gherkin-style `Given/When/Then` lines are used instead.
 * Returns an empty list rather than guessing — the caller then says so.
 */
export function extractAcceptanceCriteria(text: string, limit = 20): string[] {
  const lines = text.split(/\r?\n/);
  const found: string[] = [];

  for (let index = 0; index < lines.length && found.length < limit; index += 1) {
    if (!CRITERIA_HEADING.test(lines[index] ?? '')) continue;
    // A heading with the criteria on the same line: "AC: user can reset".
    const inline = /[:：]\s*(.{8,})$/.exec(lines[index] ?? '')?.[1];
    if (inline && !LIST_ITEM.test(inline)) found.push(inline.trim());

    let started = false;
    for (let next = index + 1; next < lines.length && found.length < limit; next += 1) {
      const line = lines[next] ?? '';
      if (!line.trim()) {
        if (started) break;
        continue;
      }
      // A single `#` is a Jira wiki numbered item, not a heading; `##` and
      // `h3.` end the list.
      if (/^\s*(?:#{2,6}\s|h[1-6]\.\s)/.test(line) || CRITERIA_HEADING.test(line)) break;
      const item = LIST_ITEM.exec(line)?.[1] ?? GHERKIN.exec(line)?.[0];
      if (item) {
        found.push(clean(item));
        started = true;
      } else if (started) {
        break;
      }
    }
  }

  if (found.length === 0) {
    for (const line of lines) {
      if (found.length >= limit) break;
      if (GHERKIN.test(line)) found.push(clean(line));
    }
  }
  return [...new Set(found)].filter(Boolean);
}

/**
 * Confluence page ids linked from a ticket.
 *
 * A spec linked from the ticket is a far better match than whatever a search
 * on the summary turns up, so linked pages are opened first.
 */
export function extractConfluencePageIds(text: string, limit = 5): string[] {
  const ids: string[] = [];
  const patterns = [/[?&]pageId=(\d+)/g, /\/pages\/(\d+)(?:[/?#]|\b)/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1] && !ids.includes(match[1])) ids.push(match[1]);
      if (ids.length >= limit) return ids;
    }
  }
  return ids;
}

/** Words that look like identifiers but never name code worth exploring. */
const STOP_WORDS = new Set([
  'README',
  'TODO',
  'FIXME',
  'JSON',
  'HTML',
  'HTTP',
  'HTTPS',
  'API',
  'UI',
  'UX',
  'URL',
  'SQL',
  'CSS',
  'JavaScript',
  'TypeScript',
  'GitHub',
  'GitLab',
  'PowerPoint',
  'YouTube',
  'LinkedIn',
  'iPhone',
  'iOS',
  'macOS',
  'OAuth',
]);

/**
 * Code names mentioned in ticket or spec text, most specific first.
 *
 * Collected in order of confidence: backticked spans and `{{monospace}}` (the
 * author marked them as code), file paths, qualified `Class.method` names,
 * `call()` expressions, then bare CamelCase / snake_case identifiers. URLs and
 * issue keys are stripped first so they cannot contribute fragments.
 */
export function extractCodeHints(text: string, limit = 20): string[] {
  const stripped = text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[A-Z][A-Z0-9_]+-\d+\b/g, ' ');
  const hints: string[] = [];
  const add = (value: string | undefined): void => {
    const hint = value
      ?.trim()
      .replace(/\(\)$/, '')
      .replace(/^[("'`]+|[)"'`,.;:]+$/g, '');
    if (!hint || hint.length < 3 || hint.length > 80) return;
    if (STOP_WORDS.has(hint) || /\s/.test(hint)) return;
    if (!hints.includes(hint)) hints.push(hint);
  };

  for (const match of stripped.matchAll(/`([^`\n]{3,80})`|\{\{([^}\n]{3,80})\}\}/g)) {
    const span = (match[1] ?? match[2] ?? '').trim();
    // A backticked command or sentence is not a symbol; keep its code-shaped words.
    if (/\s/.test(span)) {
      for (const word of span.split(/\s+/)) if (looksLikeCode(word)) add(word);
    } else {
      add(span);
    }
  }
  for (const match of stripped.matchAll(/(?:^|[\s(])((?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,6})\b/g)) {
    add(match[1]);
  }
  for (const match of stripped.matchAll(/\b([A-Z][A-Za-z0-9_]*(?:\.[a-z_$][\w$]*)+)\b/g)) add(match[1]);
  for (const match of stripped.matchAll(/\b([A-Za-z_$][\w$]{2,})\(\)/g)) add(match[1]);
  for (const match of stripped.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+|[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) {
    add(match[1]);
  }
  return hints.slice(0, limit);
}

function looksLikeCode(word: string): boolean {
  return (
    /[A-Za-z]\.[A-Za-z]/.test(word) ||
    /\w\(\)$/.test(word) ||
    /^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(word) ||
    /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(word) ||
    /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(word)
  );
}

function clean(item: string): string {
  return item.replace(/\s+/g, ' ').replace(/^\[[ xX]\]\s*/, '').trim();
}
