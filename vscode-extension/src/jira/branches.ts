/**
 * The Jira ↔ Git branch mapping behind the board's one-click checkout.
 *
 * Two halves, deliberately separated so the interesting rules can be tested
 * without a repository:
 *
 *   - **Pure**: reading an issue key out of a branch name, turning a summary
 *     into a branch-safe slug, and {@link planCheckout} — which decides whether
 *     a key means "switch to the branch that exists", "track the one that only
 *     exists on the remote", or "create a new one".
 *   - **Process**: thin wrappers over `git`, all of which report failure as a
 *     value instead of throwing, because every one of them is reachable from a
 *     button in a webview and a raw git error is not an answer a user can act
 *     on.
 */

import { runProcess } from '../runtime';
import { BoardIssue } from './model';

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

/** Whether a branch name refers to an issue. */
export function branchMatchesIssue(branch: string, issueKey: string): boolean {
  const key = issueKey.toUpperCase();
  const project = key.split('-')[0];
  return extractIssueKey(branch, project ? [project] : []) === key;
}

/** Combining marks left behind by NFKD decomposition. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Turn an issue summary into the trailing part of a branch name: lower case,
 * hyphen separated, ASCII only, and cut on a word boundary so the result reads
 * like something a person would have typed.
 */
export function slugify(summary: string, maxLength = 48): string {
  const words = summary
    .normalize('NFKD')
    // Strip combining marks so "Cập nhật" becomes "cap-nhat" instead of losing
    // every accented word for not being ASCII.
    .replace(COMBINING_MARKS, '')
    .replace(/[Đđ]/g, 'd') // Đ / đ decompose to nothing above.
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  const parts: string[] = [];
  let length = 0;
  for (const word of words) {
    if (parts.length > 0 && length + 1 + word.length > maxLength) break;
    length += (parts.length > 0 ? 1 : 0) + word.length;
    parts.push(word);
  }
  return parts.join('-').slice(0, maxLength).replace(/-+$/, '');
}

/**
 * Conventional directory prefix for an issue type.
 *
 * `Task` and `Sub-task` deliberately land in `feature`: in most Jira projects
 * they carry ordinary development work, and only the types naming upkeep
 * explicitly (`Chore`, `Maintenance`) get `chore`.
 */
export function typePrefix(type: string): string {
  const normalized = type.toLowerCase();
  if (/bug|defect|fault|error/.test(normalized)) return 'bugfix';
  if (/hotfix|incident/.test(normalized)) return 'hotfix';
  if (/spike|research|investigat/.test(normalized)) return 'spike';
  if (/chore|maintenance|upgrade/.test(normalized)) return 'chore';
  return 'feature';
}

export const DEFAULT_BRANCH_TEMPLATE = '{prefix}/{key}-{summary}';

/**
 * Render a branch name for an issue.
 *
 * Placeholders: `{key}`, `{summary}` (slug), `{prefix}` (from the issue type),
 * `{type}`. An unknown placeholder is left alone rather than blanked, so a typo
 * in the setting shows up in the suggestion instead of silently producing
 * `feature/-958`.
 */
export function branchNameFor(
  issue: Pick<BoardIssue, 'key' | 'summary' | 'type'>,
  template: string = DEFAULT_BRANCH_TEMPLATE,
  maxSummaryLength = 48,
): string {
  const values: Record<string, string> = {
    key: issue.key,
    summary: slugify(issue.summary, maxSummaryLength),
    prefix: typePrefix(issue.type),
    type: slugify(issue.type, 20),
  };
  const rendered = (template.trim() || DEFAULT_BRANCH_TEMPLATE).replace(
    /\{(\w+)\}/g,
    (whole, name: string) => values[name] ?? whole,
  );
  return sanitizeBranchName(rendered);
}

/** ASCII control characters, which git refuses in a ref name. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * Make a string usable as a git ref.
 *
 * `git check-ref-format` rejects rather more than people expect — a trailing
 * dot, `..`, `@{`, a `.lock` suffix, and the shell-hostile ``~^:?*[\`` set. A
 * suggestion git refuses is worse than a slightly rewritten one, so the cleanup
 * happens here rather than at a failed `git checkout`.
 */
export function sanitizeBranchName(name: string): string {
  return name
    .replace(CONTROL_CHARACTERS, '')
    .replace(/@\{/g, '-')
    .replace(/[\s~^:?*[\]\\]+/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/\.lock(?=$|\/)/g, 'lock')
    .split('/')
    .map((segment) => segment.replace(/^[.\-]+/, '').replace(/[.\-]+$/, ''))
    .filter(Boolean)
    .join('/');
}

export function isValidBranchName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed === sanitizeBranchName(trimmed);
}

// ------------------------------------------------------------------- git reads

export interface BranchInfo {
  /** Short name: `feature/x` locally, `origin/feature/x` for a remote ref. */
  name: string;
  /** Local name a remote branch would be checked out as. */
  localName: string;
  remote?: string;
  isRemote: boolean;
  isCurrent: boolean;
  upstream?: string;
  /** ISO timestamp of the branch tip, used to order the candidates. */
  committedAt?: string;
  subject?: string;
  issueKey?: string;
}

const BRANCH_FORMAT = [
  '%(refname:short)',
  '%(refname)',
  '%(upstream:short)',
  '%(committerdate:iso-strict)',
  '%(contents:subject)',
].join('%09');

async function git(
  cwd: string,
  args: readonly string[],
  maxOutputCharacters = 200_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await runProcess('git', args, { cwd, maxOutputCharacters });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  const result = await git(cwd, ['rev-parse', '--is-inside-work-tree'], 1000);
  return result.code === 0 && result.stdout.trim() === 'true';
}

/** The checked-out branch, or `undefined` on a detached HEAD. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  const result = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 1000);
  const name = result.stdout.trim();
  return result.code === 0 && name && name !== 'HEAD' ? name : undefined;
}

/** Parse `git for-each-ref` output. Split out so it can be tested directly. */
export function parseBranchLines(stdout: string, current?: string): BranchInfo[] {
  const branches: BranchInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name, refname, upstream, committedAt, ...subject] = line.split('\t');
    if (!name || !refname) continue;
    // `origin/HEAD` is a symbolic pointer at the default branch, not a branch
    // anyone checks out by that name.
    if (/\/HEAD$/.test(name)) continue;

    const isRemote = refname.startsWith('refs/remotes/');
    const remote = isRemote ? name.split('/')[0] : undefined;
    const localName = isRemote && remote ? name.slice(remote.length + 1) : name;
    const issueKey = extractIssueKey(localName);
    const subjectLine = subject.join('\t').trim();

    branches.push({
      name,
      localName,
      isRemote,
      isCurrent: !isRemote && name === current,
      ...(remote ? { remote } : {}),
      ...(upstream ? { upstream } : {}),
      ...(committedAt ? { committedAt } : {}),
      ...(subjectLine ? { subject: subjectLine } : {}),
      ...(issueKey ? { issueKey } : {}),
    });
  }
  return branches;
}

/** Every local and remote branch, newest tip first. */
export async function listBranches(cwd: string): Promise<BranchInfo[]> {
  const [current, refs] = await Promise.all([
    currentBranch(cwd),
    git(cwd, [
      'for-each-ref',
      `--format=${BRANCH_FORMAT}`,
      '--sort=-committerdate',
      'refs/heads',
      'refs/remotes',
    ]),
  ]);
  if (refs.code !== 0) return [];
  return parseBranchLines(refs.stdout, current);
}

export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const result = await git(cwd, ['status', '--porcelain', '--untracked-files=no'], 100_000);
  return result.code === 0 && result.stdout.trim() !== '';
}

// ------------------------------------------------------------------- planning

export type CheckoutAction = 'switch' | 'track' | 'create';

export interface CheckoutPlan {
  action: CheckoutAction;
  /** Name to switch to, track, or create. */
  branch: string;
  /** The remote ref to track, set only for `track`. */
  remoteRef?: string;
  /** Every branch carrying the key, best first — offered when it is ambiguous. */
  candidates: BranchInfo[];
  /** True when the issue's branch is the one already checked out. */
  alreadyOnBranch: boolean;
}

/**
 * Decide what "check out the branch for TPLD-958" means in this repository.
 *
 * Preference order is the one that surprises least: a local branch (the one the
 * developer already has), then a remote-only branch (a teammate started it, or
 * it exists from another machine), then a new branch from the suggested name. A
 * remote branch a local one already tracks is not offered twice.
 */
export function planCheckout(
  branches: readonly BranchInfo[],
  issueKey: string,
  suggestion: string,
): CheckoutPlan {
  const key = issueKey.toUpperCase();
  const matching = branches.filter((branch) => branch.issueKey === key);
  const locals = matching.filter((branch) => !branch.isRemote);
  const trackedLocally = new Set(
    locals.map((branch) => branch.upstream).filter((name): name is string => Boolean(name)),
  );
  const remotes = matching.filter(
    (branch) => branch.isRemote && !trackedLocally.has(branch.name),
  );
  const candidates = [...locals, ...remotes];

  const current = locals.find((branch) => branch.isCurrent);
  if (current) {
    return { action: 'switch', branch: current.name, candidates, alreadyOnBranch: true };
  }

  const local = locals[0];
  if (local) {
    return { action: 'switch', branch: local.name, candidates, alreadyOnBranch: false };
  }

  const remote = remotes[0];
  if (remote) {
    return {
      action: 'track',
      branch: remote.localName,
      remoteRef: remote.name,
      candidates,
      alreadyOnBranch: false,
    };
  }

  return {
    action: 'create',
    branch: sanitizeBranchName(suggestion),
    candidates,
    alreadyOnBranch: false,
  };
}

// ------------------------------------------------------------------ git writes

export interface GitOutcome {
  ok: boolean;
  /** One sentence, ready to show in a notification. */
  message: string;
}

function failure(result: { stderr: string; stdout: string }, fallback: string): GitOutcome {
  const reason = (result.stderr || result.stdout)
    .split(/\r?\n/)
    .find((line) => line.trim());
  return { ok: false, message: reason?.trim() || fallback };
}

/** Switch to an existing local branch. */
export async function switchBranch(cwd: string, branch: string): Promise<GitOutcome> {
  const result = await git(cwd, ['checkout', branch]);
  return result.code === 0
    ? { ok: true, message: `Switched to ${branch}.` }
    : failure(result, `Could not switch to ${branch}.`);
}

/** Create a local branch tracking a remote one. */
export async function trackRemoteBranch(
  cwd: string,
  branch: string,
  remoteRef: string,
): Promise<GitOutcome> {
  const result = await git(cwd, ['checkout', '-b', branch, '--track', remoteRef]);
  return result.code === 0
    ? { ok: true, message: `Created ${branch} tracking ${remoteRef}.` }
    : failure(result, `Could not track ${remoteRef}.`);
}

/** Create and switch to a new branch, optionally from a specific base. */
export async function createBranch(
  cwd: string,
  branch: string,
  base?: string,
): Promise<GitOutcome> {
  const args = base ? ['checkout', '-b', branch, base] : ['checkout', '-b', branch];
  const result = await git(cwd, args);
  return result.code === 0
    ? { ok: true, message: base ? `Created ${branch} from ${base}.` : `Created ${branch}.` }
    : failure(result, `Could not create ${branch}.`);
}

/**
 * Fetch, so a branch a teammate pushed a minute ago is visible.
 *
 * Best-effort by design: no network, no credentials, or no remote at all is a
 * normal state for a local repository and must never stop a checkout that only
 * needs local refs.
 */
export async function fetchRemotes(cwd: string): Promise<GitOutcome> {
  const result = await git(cwd, ['fetch', '--all', '--prune', '--quiet'], 20_000);
  return result.code === 0
    ? { ok: true, message: 'Fetched remote branches.' }
    : failure(result, 'Could not reach the remote.');
}
