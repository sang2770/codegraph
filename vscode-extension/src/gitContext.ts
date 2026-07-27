import { runProcess } from './runtime';

export interface GitReviewContext {
  isRepository: boolean;
  status: string;
  stat: string;
  diff: string;
  changedFiles: string[];
  truncated: boolean;
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
      git(cwd, ['diff', '--stat', 'HEAD', '--'], 100_000),
      git(cwd, ['diff', '--name-only', 'HEAD', '--'], 100_000),
      git(cwd, ['diff', '--name-only', '--cached', '--'], 100_000),
      git(cwd, ['ls-files', '--others', '--exclude-standard'], 100_000),
    ]);

  let diff = await git(
    cwd,
    ['diff', '--no-ext-diff', '--no-color', '--unified=12', 'HEAD', '--'],
    maxDiffCharacters,
  );

  if (diff.code !== 0) {
    const [stagedDiff, worktreeDiff] = await Promise.all([
      git(
        cwd,
        ['diff', '--cached', '--no-ext-diff', '--no-color', '--unified=12', '--'],
        Math.ceil(maxDiffCharacters / 2),
      ),
      git(
        cwd,
        ['diff', '--no-ext-diff', '--no-color', '--unified=12', '--'],
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
