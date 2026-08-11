import { statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Bytes-per-token ratio used for every estimate in this extension. It is a
 * rough industry heuristic, not a tokenizer. Both sides of every comparison
 * use the same ratio, so the resulting ratio between them is meaningful even
 * though each absolute number is approximate.
 */
export const CHARACTERS_PER_TOKEN = 4;

/** Upper bound on files measured for one baseline, to keep the stat loop cheap. */
const MAX_MEASURED_FILES = 400;

export interface BaselineMeasurement {
  /** Files whose real on-disk byte size was read. */
  measuredFiles: number;
  /**
   * Candidate files that were named but could not be measured (deleted,
   * unreadable, a directory, or resolved outside the workspace root).
   */
  unmeasuredFiles: number;
  /** Sum of the measured files' real sizes in bytes. */
  bytes: number;
  /** `bytes` expressed in tokens. */
  tokens: number;
  /** False when nothing could be measured; savings are then unknown, not zero. */
  measured: boolean;
}

export const EMPTY_BASELINE: BaselineMeasurement = {
  measuredFiles: 0,
  unmeasuredFiles: 0,
  bytes: 0,
  tokens: 0,
  measured: false,
};

/**
 * Measure what it would really cost to read `files` in full, by reading their
 * actual sizes off disk.
 *
 * This replaces the previous approach of multiplying a file count by a guessed
 * per-file token constant. A guessed constant produces a savings percentage
 * that is fixed by arithmetic rather than derived from the repository, which is
 * indistinguishable from a made-up number.
 */
export function measureFileReadBaseline(
  root: string,
  files: readonly string[],
): BaselineMeasurement {
  const rootPath = resolve(root);
  const seen = new Set<string>();
  let measuredFiles = 0;
  let unmeasuredFiles = 0;
  let bytes = 0;

  for (const file of files) {
    if (measuredFiles >= MAX_MEASURED_FILES) {
      break;
    }
    const target = resolve(rootPath, file);
    // Never stat outside the workspace root, and never count a path twice.
    if (target !== rootPath && !target.startsWith(`${rootPath}${sep}`)) {
      unmeasuredFiles += 1;
      continue;
    }
    if (seen.has(target)) {
      continue;
    }
    seen.add(target);
    try {
      const stats = statSync(target);
      if (!stats.isFile()) {
        unmeasuredFiles += 1;
        continue;
      }
      bytes += stats.size;
      measuredFiles += 1;
    } catch {
      unmeasuredFiles += 1;
    }
  }

  return {
    measuredFiles,
    unmeasuredFiles,
    bytes,
    tokens: Math.ceil(bytes / CHARACTERS_PER_TOKEN),
    measured: measuredFiles > 0,
  };
}

/**
 * Pull workspace-relative file paths out of a CodeBrain context block.
 *
 * The graph output names every file it drew evidence from, so these are exactly
 * the files an agent would otherwise have had to open. That makes them the
 * correct population to measure a read baseline against.
 */
export function extractContextFilePaths(
  graphContext: string,
  limit = MAX_MEASURED_FILES,
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const pattern =
    /(?:^|[\s*_(`])((?:[\w@.-]+\/)+[\w@.+-]+\.[A-Za-z0-9]+)(?::\d+)?/gm;
  for (const match of graphContext.matchAll(pattern)) {
    const path = match[1]?.replaceAll('\\', '/');
    if (!path || path.startsWith('http') || seen.has(path)) {
      continue;
    }
    seen.add(path);
    paths.push(path);
    if (paths.length >= limit) {
      break;
    }
  }
  return paths;
}
