import { runProcess } from './runtime';

export interface GitReviewContext {
  isRepository: boolean;
  status: string;
  stat: string;
  diff: string;
  changedFiles: string[];
  truncated: boolean;
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
