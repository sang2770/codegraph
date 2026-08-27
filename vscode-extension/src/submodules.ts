/**
 * Git submodules as CodeBrain sees them: separate projects that live inside the
 * open workspace and each need an index of their own.
 *
 * A submodule is its own repository with its own history, so the outer repo's
 * index does not cover it — `codegraph init` has to run inside it. The parsing
 * is split from the process call so the interesting part (which submodules are
 * actually checked out, which are empty placeholders) can be tested without a
 * repository.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { runProcess } from './runtime';
import { INDEX_DIRECTORY } from './workspace';

/** One submodule of a repository. */
export interface SubmoduleEntry {
  /** Path as git reports it, relative to the repository root, `/`-separated. */
  relativePath: string;
  /** Absolute path on disk. */
  path: string;
  /** Last segment of the path — what the tree shows as the module's name. */
  name: string;
  /**
   * False for a submodule that is registered but never checked out (`git
   * submodule status` marks it with `-`). There is nothing on disk to index, so
   * it is offered with an explanation rather than an init that would fail.
   */
  checkedOut: boolean;
  /** Whether this submodule already owns a `.codegraph/` index. */
  indexed: boolean;
}

/**
 * Parse `git submodule status --recursive`.
 *
 * Each line is `<flag><sha> <path> (<describe>)`, where the flag is a space for
 * a submodule in sync, `-` for one that is not checked out, `+` for one at a
 * different commit than recorded and `U` for one with merge conflicts. Only the
 * `-` case changes what CodeBrain can do, so the rest are treated alike.
 *
 * A path may contain spaces, and the trailing `(…)` is optional, so the path is
 * taken as everything between the sha and an optional parenthesised tail rather
 * than by splitting on whitespace.
 */
export function parseSubmoduleStatus(stdout: string, root: string): SubmoduleEntry[] {
  const entries: SubmoduleEntry[] = [];
  const seen = new Set<string>();

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^(.)([0-9a-fA-F]{7,64})\s+(.+?)(?:\s+\((.*)\))?$/.exec(line);
    if (!match) continue;
    const [, flag, , rawPath] = match;
    if (!rawPath) continue;

    const relativePath = rawPath.trim().replace(/\\/g, '/');
    // A path that escapes the repository, or an absolute one, cannot have come
    // from a submodule inside it — refuse rather than resolving it.
    if (!relativePath || relativePath.startsWith('../') || isAbsolute(relativePath)) {
      continue;
    }
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);

    const absolute = resolve(root, ...relativePath.split('/'));
    const segments = relativePath.split('/');
    entries.push({
      relativePath,
      path: absolute,
      name: segments[segments.length - 1] ?? relativePath,
      // `-` means "registered but empty"; anything else has a working tree.
      checkedOut: flag !== '-',
      indexed: existsSync(join(absolute, INDEX_DIRECTORY)),
    });
  }

  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/**
 * Every submodule of the repository at `root`, nested ones included.
 *
 * Reported as an empty list rather than an error when there is no repository,
 * no submodules, or no git on the PATH: this feeds a tree view and a picker,
 * both of which have something sensible to show with nothing in them.
 */
export async function listSubmodules(root: string): Promise<SubmoduleEntry[]> {
  if (!existsSync(join(root, '.gitmodules'))) return [];
  try {
    const result = await runProcess('git', ['submodule', 'status', '--recursive'], {
      cwd: root,
      maxOutputCharacters: 200_000,
    });
    if (result.code !== 0) return [];
    return parseSubmoduleStatus(result.stdout, root);
  } catch {
    // No git on the PATH. The rest of the extension still works.
    return [];
  }
}
