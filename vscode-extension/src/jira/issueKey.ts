/**
 * Reading a Jira issue key out of free text.
 *
 * Its own module, free of any VS Code or process dependency, because the
 * standalone Atlassian server bundle (and its Claude Code prompt hook) needs
 * the same rule the board uses for branch names.
 */

/**
 * An issue key: a project key of at least two letters, a hyphen, a number.
 *
 * Matched case-insensitively because branch names are commonly lower-cased
 * (`feature/tpld-958-chart-lag`), and bounded by a non-alphanumeric so
 * `release/v2-1` cannot contribute a key.
 */
const ISSUE_KEY = /(?:^|[^A-Za-z0-9])([A-Za-z]{2,}[A-Za-z0-9]*)-(\d+)(?![0-9])/g;

/**
 * The first issue key in a string (a branch name, a commit subject), upper-cased.
 *
 * Purely syntactic, so a branch like `chore/node-22` does produce `NODE-22`.
 * Pass `knownProjects` wherever a wrong key would be worse than no key — the
 * board knows which project keys it loaded, and only a key from one of them is
 * then accepted. Returns `undefined` rather than guessing.
 */
export function extractIssueKey(
  text: string | undefined,
  knownProjects: readonly string[] = [],
): string | undefined {
  if (!text) return undefined;
  const allowed = new Set(knownProjects.map((project) => project.toUpperCase()));
  // A fresh regex per call: the shared literal is global, so a retained
  // lastIndex would make the same input match differently on the second call.
  const pattern = new RegExp(ISSUE_KEY.source, 'g');
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const [, project, number] = match;
    if (!project || !number) continue;
    if (allowed.size === 0 || allowed.has(project.toUpperCase())) {
      return `${project.toUpperCase()}-${number}`;
    }
  }
  return undefined;
}

/**
 * Prefixes that look like issue keys in ordinary technical prose — `UTF-8`,
 * `SHA-256`, `ES-2022`, `RFC-7231` — and never name a Jira project in practice.
 */
const PROSE_PREFIXES = new Set([
  'UTF', 'SHA', 'MD', 'ES', 'ECMA', 'ISO', 'RFC', 'HTTP', 'TLS', 'SSL', 'IPV',
  'CVE', 'CWE', 'PEP', 'JSR', 'JEP', 'KB', 'MS', 'WIN', 'COVID', 'AES', 'RSA',
  'NODE', 'PY', 'PYTHON', 'JAVA', 'GO', 'VUE', 'IE', 'CP', 'LATIN', 'X', 'TOP', 'STEP',
]);

/**
 * The first issue key in a user's prompt.
 *
 * Stricter than {@link extractIssueKey}: a prompt is free prose, so a key whose
 * project prefix is a well-known standard or encoding name (`UTF-8`) is skipped
 * rather than sent to Jira as a ticket.
 */
export function extractPromptIssueKey(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const pattern = new RegExp(ISSUE_KEY.source, 'g');
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const [, project, number] = match;
    if (!project || !number || PROSE_PREFIXES.has(project.toUpperCase())) continue;
    return `${project.toUpperCase()}-${number}`;
  }
  return undefined;
}
