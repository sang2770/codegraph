import { relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import {
  codeBrainEnvironment,
  runCodeBrain,
  RuntimeCommand,
} from './runtime';
import { INDEX_DIRECTORY } from './workspace';

/** Paths whose changes never require a re-index. */
const IGNORED_SEGMENTS = [
  INDEX_DIRECTORY,
  '.git',
  'node_modules',
  '.venv',
  '__pycache__',
  'dist',
  'build',
  'out',
  'target',
];

export interface FreshnessResult {
  /** A sync ran for this request. */
  synced: boolean;
  /** The sync was skipped because the index was already known to be current. */
  skipped: boolean;
  /** Why it was skipped or run, for the output channel. */
  reason: string;
}

/**
 * Whether a change inside `root` can be ignored.
 *
 * The test is against the path *relative to the project*, never the absolute
 * one. Checking the absolute path means a checkout that merely lives under a
 * directory called `build`, `dist`, or `out` has every one of its changes
 * ignored — the project is then never marked stale, so it silently stops
 * refreshing and answers from the first index of the session forever.
 */
export function isIgnoredPath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith('..')) {
    return true;
  }
  return relativePath
    .split(/[\\/]/)
    .some((part) => IGNORED_SEGMENTS.includes(part));
}

function isUnder(root: string, filePath: string): boolean {
  return filePath === root || filePath.startsWith(`${root}${sep}`);
}

/**
 * Tracks whether a project's index is known to be current, so an analysis can
 * skip the refresh that used to run before *every* request.
 *
 * The old unconditional `sync` was pure latency in the common case: the
 * runtime's own file watcher already keeps the index fresh, so most refreshes
 * had nothing to do yet still paid full process-spawn and tree-walk cost on
 * every question. Watching the workspace from the extension side answers
 * "did anything change since our last sync?" without spawning anything.
 *
 * A project starts *unknown* (treated as stale) because changes made while the
 * window was closed are invisible to us — so the first analysis of a session
 * always refreshes.
 */
export class IndexFreshness implements vscode.Disposable {
  /** Roots whose index is known to match the working tree. */
  private readonly clean = new Set<string>();
  /** Bumped whenever a root's content changes; invalidates cached graph output. */
  private readonly generations = new Map<string, number>();
  /** In-flight syncs, so concurrent requests share one refresh. */
  private readonly inFlight = new Map<string, Promise<FreshnessResult>>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidChangeEmitter = new vscode.EventEmitter<string>();

  /** Fires with the project root whenever its content changes. */
  public readonly onDidChangeProject = this.onDidChangeEmitter.event;

  public constructor(
    private readonly runtime: RuntimeCommand,
    private readonly log: (message: string) => void,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher,
      this.onDidChangeEmitter,
      watcher.onDidCreate((uri) => this.handleChange(uri)),
      watcher.onDidChange((uri) => this.handleChange(uri)),
      watcher.onDidDelete((uri) => this.handleChange(uri)),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private handleChange(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') {
      return;
    }
    const changed = resolve(uri.fsPath);
    // Invalidate every tracked root that contains the changed file, exactly
    // once per change. Roots we have never synced are already stale, so they
    // need no marking — but they still need a generation bump to drop caches.
    for (const root of new Set([...this.clean, ...this.generations.keys()])) {
      if (!isUnder(root, changed) || isIgnoredPath(relative(root, changed))) {
        continue;
      }
      this.clean.delete(root);
      this.bump(root);
      this.onDidChangeEmitter.fire(root);
    }
  }

  private bump(root: string): void {
    this.generations.set(root, (this.generations.get(root) ?? 0) + 1);
  }

  /**
   * Cache generation for a root. Any cached graph output tagged with an older
   * generation is stale and must not be reused.
   */
  public generation(root: string): number {
    const key = resolve(root);
    if (!this.generations.has(key)) {
      this.generations.set(key, 0);
    }
    return this.generations.get(key) ?? 0;
  }

  public isKnownFresh(root: string): boolean {
    return this.clean.has(resolve(root));
  }

  /** Force the next analysis to refresh, e.g. after a manual index rebuild. */
  public invalidate(root: string): void {
    const key = resolve(root);
    this.clean.delete(key);
    this.bump(key);
  }

  /** Record that a refresh outside this class brought the index up to date. */
  public markFresh(root: string): void {
    this.clean.add(resolve(root));
  }

  /**
   * Refresh the index only when something may have changed since the last one.
   *
   * Throws when a needed refresh fails, so an analysis never silently runs
   * against a stale index.
   */
  public async ensureFresh(
    folder: vscode.WorkspaceFolder,
    token?: vscode.CancellationToken,
  ): Promise<FreshnessResult> {
    const root = resolve(folder.uri.fsPath);
    const refreshEnabled = vscode.workspace
      .getConfiguration('codebrain')
      .get<boolean>('review.refreshIndexBeforeRun', true);
    if (!refreshEnabled) {
      return {
        synced: false,
        skipped: true,
        reason: 'codebrain.review.refreshIndexBeforeRun is disabled.',
      };
    }
    if (this.clean.has(root)) {
      this.log(
        `[freshness] skipped refresh for ${root}: no workspace change since the last sync.`,
      );
      return {
        synced: false,
        skipped: true,
        reason: 'No workspace change since the last refresh.',
      };
    }

    const existing = this.inFlight.get(root);
    if (existing) {
      try {
        return await existing;
      } catch (error) {
        // The refresh we joined belonged to another request. If that request
        // was cancelled, its failure is not ours — start our own rather than
        // aborting an analysis the user never cancelled.
        if (token?.isCancellationRequested) {
          throw error;
        }
        this.log('[freshness] joined refresh failed; retrying for this request.');
      }
    }

    const pending = this.runSync(root, token).finally(() => {
      this.inFlight.delete(root);
    });
    this.inFlight.set(root, pending);
    return pending;
  }

  private async runSync(
    root: string,
    token?: vscode.CancellationToken,
  ): Promise<FreshnessResult> {
    // Snapshot the generation first. A file saved while the sync is running may
    // not have been picked up by it, and marking the root clean regardless
    // would suppress the next refresh and leave the analysis on stale data.
    const startedAt = this.generation(root);
    const result = await runCodeBrain(this.runtime, ['sync', root], {
      cwd: root,
      env: codeBrainEnvironment(),
      token,
    });
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          'CodeBrain index refresh failed; the analysis was not started against a stale index.',
      );
    }
    const changedDuringSync = this.generation(root) !== startedAt;
    if (!changedDuringSync) {
      this.clean.add(root);
    }
    this.log(
      changedDuringSync
        ? `[freshness] refreshed index for ${root}, but the workspace changed mid-refresh — staying stale.`
        : `[freshness] refreshed index for ${root}.`,
    );
    return {
      synced: true,
      skipped: false,
      reason: 'Workspace changed since the last refresh.',
    };
  }
}
