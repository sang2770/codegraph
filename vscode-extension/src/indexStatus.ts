import { relative } from 'node:path';
import * as vscode from 'vscode';
import {
  codeBrainEnvironment,
  runCodeBrain,
  RuntimeCommand,
} from './runtime';

/** Completeness of the last full index run, as reported by the runtime. */
export type IndexState = 'indexing' | 'complete' | 'partial' | 'failed' | null;

export interface IndexStatus {
  initialized: boolean;
  version?: string;
  projectPath?: string;
  indexPath?: string;
  lastIndexed?: string | null;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  dbSizeBytes: number;
  backend?: string;
  journalMode?: string;
  languages: string[];
  pendingChanges: { added: number; modified: number; removed: number };
  worktreeMismatch?: { worktreeRoot: string; indexRoot: string } | null;
  index: {
    builtWithVersion?: string | null;
    reindexRecommended: boolean;
    state: IndexState;
    pendingRefs: number;
  };
}

export interface IndexedFile {
  path: string;
  language: string;
  nodeCount: number;
}

export interface LanguageCoverage {
  language: string;
  files: number;
  symbols: number;
  /**
   * Files present in the index but with no extracted symbols. These are tracked
   * for change detection only, so they cannot appear in a call path.
   */
  filesWithoutSymbols: number;
}

export interface CoverageReport {
  indexedFiles: number;
  languages: LanguageCoverage[];
  /** Workspace files missing from the index, grouped by extension. */
  unindexed: Array<{ extension: string; files: number }>;
  unindexedTotal: number;
  /**
   * True when either list was capped, so the gaps below are a lower bound. Set
   * to keep the panel from presenting a truncated scan as a complete audit.
   */
  incomplete: boolean;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function parseIndexStatus(text: string): IndexStatus | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const pending = (raw.pendingChanges ?? {}) as Record<string, unknown>;
  const index = (raw.index ?? {}) as Record<string, unknown>;
  const state = index.state;
  return {
    initialized: raw.initialized === true,
    version: typeof raw.version === 'string' ? raw.version : undefined,
    projectPath: typeof raw.projectPath === 'string' ? raw.projectPath : undefined,
    indexPath: typeof raw.indexPath === 'string' ? raw.indexPath : undefined,
    lastIndexed: typeof raw.lastIndexed === 'string' ? raw.lastIndexed : null,
    fileCount: asNumber(raw.fileCount),
    nodeCount: asNumber(raw.nodeCount),
    edgeCount: asNumber(raw.edgeCount),
    dbSizeBytes: asNumber(raw.dbSizeBytes),
    backend: typeof raw.backend === 'string' ? raw.backend : undefined,
    journalMode: typeof raw.journalMode === 'string' ? raw.journalMode : undefined,
    languages: Array.isArray(raw.languages)
      ? raw.languages.filter((item): item is string => typeof item === 'string')
      : [],
    pendingChanges: {
      added: asNumber(pending.added),
      modified: asNumber(pending.modified),
      removed: asNumber(pending.removed),
    },
    worktreeMismatch:
      typeof raw.worktreeMismatch === 'object' && raw.worktreeMismatch !== null
        ? (raw.worktreeMismatch as { worktreeRoot: string; indexRoot: string })
        : null,
    index: {
      builtWithVersion:
        typeof index.builtWithVersion === 'string' ? index.builtWithVersion : null,
      reindexRecommended: index.reindexRecommended === true,
      state:
        state === 'indexing' || state === 'complete' || state === 'partial' || state === 'failed'
          ? state
          : null,
      pendingRefs: asNumber(index.pendingRefs),
    },
  };
}

export function parseIndexedFiles(text: string): IndexedFile[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  // `files --json` may wrap the list; accept both shapes.
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { files?: unknown })?.files)
      ? ((raw as { files: unknown[] }).files)
      : [];
  const files: IndexedFile[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.path !== 'string') continue;
    files.push({
      path: entry.path.replaceAll('\\', '/').replace(/^\.\//, ''),
      language: typeof entry.language === 'string' ? entry.language : 'unknown',
      nodeCount: asNumber(entry.nodeCount),
    });
  }
  return files;
}

export async function readIndexStatus(
  runtime: RuntimeCommand,
  root: string,
  token?: vscode.CancellationToken,
): Promise<IndexStatus | undefined> {
  const result = await runCodeBrain(runtime, ['status', root, '--json'], {
    cwd: root,
    env: codeBrainEnvironment(),
    token,
  });
  if (result.code !== 0) {
    return undefined;
  }
  return parseIndexStatus(result.stdout);
}

export async function readIndexedFiles(
  runtime: RuntimeCommand,
  root: string,
  token?: vscode.CancellationToken,
): Promise<{ files: IndexedFile[]; truncated: boolean }> {
  const result = await runCodeBrain(
    runtime,
    ['files', '--path', root, '--format', 'flat', '--json'],
    {
      cwd: root,
      env: codeBrainEnvironment(),
      token,
      // A large monorepo's file list exceeds the default cap; a truncated list
      // would look like missing coverage, so allow far more and report the cap.
      maxOutputCharacters: 16_000_000,
    },
  );
  if (result.code !== 0) {
    return { files: [], truncated: true };
  }
  return { files: parseIndexedFiles(result.stdout), truncated: result.truncated };
}

/**
 * Compare what the index contains against what the workspace holds.
 *
 * The failure this exists to expose is silent: a file in an unsupported
 * language is simply absent from the graph, so every impact analysis that
 * should have crossed it is quietly incomplete with no warning anywhere.
 */
export function buildCoverageReport(
  indexed: readonly IndexedFile[],
  workspaceRelativePaths: readonly string[],
  incomplete = false,
): CoverageReport {
  const byLanguage = new Map<string, LanguageCoverage>();
  const indexedPaths = new Set<string>();
  for (const file of indexed) {
    indexedPaths.add(file.path);
    const entry = byLanguage.get(file.language) ?? {
      language: file.language,
      files: 0,
      symbols: 0,
      filesWithoutSymbols: 0,
    };
    entry.files += 1;
    entry.symbols += file.nodeCount;
    if (file.nodeCount === 0) {
      entry.filesWithoutSymbols += 1;
    }
    byLanguage.set(file.language, entry);
  }

  const missingByExtension = new Map<string, number>();
  let unindexedTotal = 0;
  for (const path of workspaceRelativePaths) {
    const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
    if (indexedPaths.has(normalized)) {
      continue;
    }
    const dot = normalized.lastIndexOf('.');
    const slash = normalized.lastIndexOf('/');
    const extension = dot > slash && dot >= 0 ? normalized.slice(dot).toLowerCase() : '(no extension)';
    missingByExtension.set(extension, (missingByExtension.get(extension) ?? 0) + 1);
    unindexedTotal += 1;
  }

  return {
    indexedFiles: indexedPaths.size,
    languages: [...byLanguage.values()].sort((a, b) => b.files - a.files),
    unindexed: [...missingByExtension.entries()]
      .map(([extension, files]) => ({ extension, files }))
      .sort((a, b) => b.files - a.files),
    unindexedTotal,
    incomplete,
  };
}

/** Warnings the runtime reports that silently degrade every later answer. */
export function statusWarnings(status: IndexStatus): string[] {
  const warnings: string[] = [];
  if (status.index.state === 'indexing') {
    warnings.push(
      'The last index run never finished, so the index is truncated. Re-run “CodeBrain: Rebuild Index”.',
    );
  } else if (status.index.state === 'partial') {
    warnings.push(
      'The last index run silently dropped files, so the index is incomplete. Re-run “CodeBrain: Rebuild Index”.',
    );
  } else if (status.index.state === 'failed') {
    warnings.push(
      'The last index run failed, so results may be incomplete. Re-run “CodeBrain: Rebuild Index”.',
    );
  }
  if (status.index.pendingRefs > 0) {
    warnings.push(
      `${status.index.pendingRefs.toLocaleString()} references are still unresolved, so some callers and impact edges are missing. Run “CodeBrain: Refresh Index”.`,
    );
  }
  if (status.index.reindexRecommended) {
    warnings.push(
      `The index was built by ${status.index.builtWithVersion ?? 'an earlier version'}; rebuild it to pick up this engine's extraction improvements.`,
    );
  }
  if (status.worktreeMismatch) {
    warnings.push(
      `This worktree (${status.worktreeMismatch.worktreeRoot}) is answering from an index built for ${status.worktreeMismatch.indexRoot}.`,
    );
  }
  const pending =
    status.pendingChanges.added +
    status.pendingChanges.modified +
    status.pendingChanges.removed;
  if (pending > 0) {
    warnings.push(
      `${pending.toLocaleString()} file change(s) are not in the index yet. Run “CodeBrain: Refresh Index”.`,
    );
  }
  return warnings;
}

/**
 * Workspace source-file paths relative to `root`, for the coverage diff.
 *
 * Uses VS Code's search excludes, so `node_modules` and other ignored trees do
 * not show up as missing coverage.
 */
export async function listWorkspaceFiles(
  folder: vscode.WorkspaceFolder,
  root: string,
  maxResults = 20_000,
): Promise<{ paths: string[]; truncated: boolean }> {
  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/*'),
    undefined,
    maxResults,
  );
  const paths = found
    .filter((uri) => uri.scheme === 'file')
    .map((uri) => relative(root, uri.fsPath).replaceAll('\\', '/'))
    .filter((path) => path && !path.startsWith('..') && !path.startsWith('.codegraph/'));
  return { paths, truncated: found.length >= maxResults };
}
