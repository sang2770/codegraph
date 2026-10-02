import { runProcess } from './runtime';

export interface GitReviewContext {
  isRepository: boolean;
  status: string;
  stat: string;
  diff: string;
  changedFiles: string[];
  truncated: boolean;
  /** Which changed files were and were not included in `diff`, when some were left out. */
  coverageNote?: string;
  target?: GitCommit;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  parent?: string;
}

async function git(
  cwd: string,
  args: readonly string[],
  maxOutputCharacters: number,
): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }> {
  return runProcess('git', args, {
    cwd,
    maxOutputCharacters,
  });
}

function cleanPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function collectGitReviewContext(
  cwd: string,
  maxDiffCharacters: number,
): Promise<GitReviewContext> {
  const repository = await git(cwd, ['rev-parse', '--is-inside-work-tree'], 1000);
  if (repository.code !== 0 || repository.stdout.trim() !== 'true') {
    return {
      isRepository: false,
      status: 'The workspace is not a Git worktree.',
      stat: '',
      diff: '',
      changedFiles: [],
      truncated: false,
    };
  }

  const [status, stat, trackedFiles, stagedFiles, untrackedFiles] =
    await Promise.all([
      git(cwd, ['status', '--short', '--untracked-files=all'], 100_000),
      git(cwd, ['diff', '--relative', '--stat', 'HEAD', '--'], 100_000),
      git(cwd, ['diff', '--relative', '--name-only', 'HEAD', '--'], 100_000),
      git(cwd, ['diff', '--relative', '--name-only', '--cached', '--'], 100_000),
      git(cwd, ['ls-files', '--others', '--exclude-standard'], 100_000),
    ]);

  let diff = await git(
    cwd,
    ['diff', '--relative', '--no-ext-diff', '--no-color', '--unified=12', 'HEAD', '--'],
    maxDiffCharacters,
  );

  if (diff.code !== 0) {
    const [stagedDiff, worktreeDiff] = await Promise.all([
      git(
        cwd,
        ['diff', '--relative', '--cached', '--no-ext-diff', '--no-color', '--unified=12', '--'],
        Math.ceil(maxDiffCharacters / 2),
      ),
      git(
        cwd,
        ['diff', '--relative', '--no-ext-diff', '--no-color', '--unified=12', '--'],
        Math.ceil(maxDiffCharacters / 2),
      ),
    ]);
    diff = {
      code: stagedDiff.code || worktreeDiff.code,
      stdout: [
        stagedDiff.stdout && '## Staged changes\n' + stagedDiff.stdout,
        worktreeDiff.stdout && '## Unstaged changes\n' + worktreeDiff.stdout,
      ]
        .filter(Boolean)
        .join('\n'),
      stderr: [stagedDiff.stderr, worktreeDiff.stderr].filter(Boolean).join('\n'),
      truncated: stagedDiff.truncated || worktreeDiff.truncated,
    };
  }

  const changedFiles = [
    ...new Set([
      ...cleanPaths(trackedFiles.stdout),
      ...cleanPaths(stagedFiles.stdout),
      ...cleanPaths(untrackedFiles.stdout),
    ]),
  ];

  return {
    isRepository: true,
    status: status.stdout.trim() || 'Working tree clean.',
    stat: stat.stdout.trim(),
    diff: diff.stdout.trim(),
    changedFiles,
    truncated:
      diff.truncated ||
      status.truncated ||
      stat.truncated ||
      trackedFiles.truncated ||
      stagedFiles.truncated ||
      untrackedFiles.truncated,
  };
}

export async function listGitCommits(
  cwd: string,
  limit = 30,
): Promise<GitCommit[]> {
  const result = await git(
    cwd,
    ['log', `-${limit}`, '--format=%H%x09%h%x09%s'],
    100_000,
  );
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length >= 3 && parts[0] && parts[1] && parts[2])
    .map(([hash, shortHash, ...subject]) => ({
      hash: hash!,
      shortHash: shortHash!,
      subject: subject.join('\t'),
    }));
}

export async function collectGitCommitReviewContext(
  cwd: string,
  commitish: string,
  maxDiffCharacters: number,
): Promise<GitReviewContext> {
  const repository = await git(cwd, ['rev-parse', '--is-inside-work-tree'], 1000);
  if (repository.code !== 0 || repository.stdout.trim() !== 'true') {
    return {
      isRepository: false,
      status: 'The workspace is not a Git worktree.',
      stat: '',
      diff: '',
      changedFiles: [],
      truncated: false,
    };
  }

  const resolved = await git(
    cwd,
    ['rev-parse', '--verify', '--end-of-options', `${commitish}^{commit}`],
    1000,
  );
  if (resolved.code !== 0) {
    throw new Error(`Git commit '${commitish}' was not found.`);
  }
  const hash = resolved.stdout.trim();
  const metadata = await git(cwd, ['show', '-s', '--format=%H%x09%h%x09%s', hash], 10_000);
  const metadataParts = metadata.stdout.trim().split('\t');
  const parents = await git(cwd, ['rev-list', '--parents', '-n', '1', hash], 10_000);
  const parent = parents.stdout.trim().split(/\s+/)[1];
  const target: GitCommit = {
    hash,
    shortHash: metadataParts[1] || hash.slice(0, 12),
    subject: metadataParts.slice(2).join('\t') || `Commit ${hash.slice(0, 12)}`,
    parent,
  };
  // `--relative` keeps every path relative to `cwd`, matching the project the
  // analysis targets. Without it a sub-project analysis receives repo-root
  // paths that no later step can resolve.
  const diffArgs = parent
    ? ['diff', '--relative', '--no-ext-diff', '--no-color', '--unified=12', parent, hash, '--']
    : ['show', '--relative', '--no-ext-diff', '--no-color', '--format=', '--unified=12', '--root', hash, '--'];
  const statArgs = parent
    ? ['diff', '--relative', '--stat', parent, hash, '--']
    : ['show', '--relative', '--stat', '--format=', '--root', hash, '--'];
  const filesArgs = parent
    ? ['diff', '--relative', '--name-only', parent, hash, '--']
    : ['diff-tree', '--relative', '--root', '--no-commit-id', '--name-only', '-r', hash];
  const [diff, stat, files] = await Promise.all([
    git(cwd, diffArgs, maxDiffCharacters),
    git(cwd, statArgs, 100_000),
    git(cwd, filesArgs, 100_000),
  ]);
  if (diff.code !== 0) {
    throw new Error(diff.stderr.trim() || 'Git commit diff could not be read.');
  }
  return {
    isRepository: true,
    status: `Reviewing commit ${target.shortHash}: ${target.subject}`,
    stat: stat.stdout.trim(),
    diff: diff.stdout.trim(),
    changedFiles: cleanPaths(files.stdout),
    truncated: diff.truncated || stat.truncated || files.truncated,
    target,
  };
}

export interface GitBranchContext extends GitReviewContext {
  /** Current branch name, or undefined on a detached HEAD. */
  branch?: string;
  /** Base the branch is compared with, e.g. `origin/main`. */
  base?: string;
  /** Commits on the branch since it left the base, newest first. */
  commits: GitCommit[];
}

/** The branch a pull request would target: the remote's default, else a conventional name that exists. */
export async function detectBaseBranch(
  cwd: string,
  preferred?: string,
): Promise<string | undefined> {
  const exists = async (ref: string) =>
    (await git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], 1000)).code === 0;
  if (preferred?.trim()) {
    for (const candidate of [preferred.trim(), `origin/${preferred.trim()}`]) {
      if (await exists(candidate)) return candidate;
    }
  }
  const remoteHead = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], 1000);
  if (remoteHead.code === 0 && remoteHead.stdout.trim()) {
    return remoteHead.stdout.trim();
  }
  for (const candidate of ['origin/main', 'origin/master', 'origin/develop', 'main', 'master', 'develop']) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Everything a pull request from the current branch would contain: the
 * commits since it left the base, and the diff from the merge base to the
 * working tree (uncommitted work included — it is usually about to be pushed).
 *
 * Without a base this degrades to the working-tree context, which is still a
 * useful description of what is about to be proposed.
 */
export async function collectGitBranchContext(
  cwd: string,
  maxDiffCharacters: number,
  preferredBase?: string,
): Promise<GitBranchContext> {
  const workingTree = await collectGitReviewContext(cwd, maxDiffCharacters);
  if (!workingTree.isRepository) {
    return { ...workingTree, commits: [] };
  }
  const branchResult = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 1000);
  const branch = branchResult.code === 0 && branchResult.stdout.trim() !== 'HEAD' ? branchResult.stdout.trim() : undefined;
  const base = await detectBaseBranch(cwd, preferredBase);
  if (!base) {
    return { ...workingTree, branch, commits: [] };
  }
  const mergeBase = await git(cwd, ['merge-base', 'HEAD', base], 1000);
  if (mergeBase.code !== 0 || !mergeBase.stdout.trim()) {
    return { ...workingTree, branch, base, commits: [] };
  }
  const fork = mergeBase.stdout.trim();
  const [log, stat, files, diff] = await Promise.all([
    git(cwd, ['log', '--format=%H%x09%h%x09%s', `${fork}..HEAD`], 100_000),
    git(cwd, ['diff', '--relative', '--stat', fork, '--'], 100_000),
    git(cwd, ['diff', '--relative', '--name-only', fork, '--'], 100_000),
    git(cwd, ['diff', '--relative', '--no-ext-diff', '--no-color', '--unified=8', fork, '--'], maxDiffCharacters),
  ]);
  const commits = log.stdout
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length >= 3 && parts[0] && parts[1])
    .map(([hash, shortHash, ...subject]) => ({ hash: hash!, shortHash: shortHash!, subject: subject.join('\t') }));
  const untracked = workingTree.changedFiles.filter((file) => !cleanPaths(files.stdout).includes(file));
  return {
    isRepository: true,
    status: workingTree.status,
    stat: stat.stdout.trim(),
    diff: diff.stdout.trim(),
    changedFiles: [...new Set([...cleanPaths(files.stdout), ...untracked])],
    truncated: diff.truncated || stat.truncated || files.truncated || log.truncated,
    branch,
    base,
    commits,
  };
}
