/**
 * The CodeGraph runtime the extension runs: where it comes from, installing it
 * the first time, and keeping it up to date.
 *
 * Sources, first match wins:
 *
 *  1. `codebrain.runtime.path` — a runtime directory the user points at (a
 *     local build from `npm run build:runtime`, an air-gapped copy). Used
 *     as-is and never updated.
 *  2. The npm-installed runtime in global storage (`runtimeInstaller.ts`),
 *     installed on first activation and updated in the background.
 *
 * Nothing inside the extension folder is ever picked up on its own: a stale
 * `runtime/` left by an old build would otherwise shadow the npm runtime
 * without the user asking for it.
 *
 * Commands never hold a runtime of their own: they call `resolve()` each time,
 * so an update takes effect for the next command without a reload, and the
 * first command after a fresh install simply waits for the install to finish.
 */

import { join } from 'node:path';
import * as vscode from 'vscode';
import { CodeBrainRuntime, describeRuntime, RuntimeCommand } from './runtime';
import {
  compareVersions,
  DEFAULT_REGISTRY,
  findNpm,
  installRuntime,
  InstalledRuntime,
  normalizeRegistry,
  npmRegistry,
  pruneRuntimes,
  readCurrent,
  resolveVersion,
  RUNTIME_PACKAGE,
  writeCurrent,
} from './runtimeInstaller';

/** Background update checks after the first one, which runs shortly after activation. */
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15_000;

export type RuntimeSource = 'custom' | 'managed';

interface ActiveRuntime {
  command: RuntimeCommand;
  source: RuntimeSource;
  /** npm version for a managed install; `undefined` for the others. */
  version?: string;
}

export class RuntimeManager implements CodeBrainRuntime, vscode.Disposable {
  private readonly didChange = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [this.didChange];
  private readonly storageRoot: string;
  private active?: ActiveRuntime;
  private pending?: Promise<RuntimeCommand>;
  private updating?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private npm?: Promise<string | undefined>;
  private startupError?: Error;

  /** Fires whenever the runtime in use changes — an install, an update, a settings change. */
  readonly onDidChange = this.didChange.event;

  constructor(
    context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
  ) {
    this.storageRoot = join(context.globalStorageUri.fsPath, 'runtime');
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codebrain.runtime')) void this.reload();
      }),
    );
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const disposable of this.disposables.reverse()) disposable.dispose();
  }

  current(): RuntimeCommand | undefined {
    return this.active?.command;
  }

  /** The npm version in use, when the runtime is the managed one. */
  currentVersion(): string | undefined {
    return this.active?.version;
  }

  resolve(): Promise<RuntimeCommand> {
    if (this.startupError) return Promise.reject(this.startupError);
    if (this.active) return Promise.resolve(this.active.command);
    if (!this.pending) this.pending = this.installFirst();
    return this.pending;
  }

  /**
   * Pick up whatever runtime is available right now, without touching the
   * network. With nothing installed yet, the first install starts in the
   * background so it is usually done before the user's first command.
   */
  start(): void {
    try {
      this.active = this.localRuntime();
    } catch (error) {
      // A broken `codebrain.runtime.path`: say so, and keep failing commands
      // with the same message rather than silently installing something else.
      this.startupError = error instanceof Error ? error : new Error(String(error));
      this.log(`[runtime] ${this.startupError.message}`);
      void vscode.window.showErrorMessage(`CodeBrain: ${this.startupError.message}`);
      return;
    }
    if (this.active) {
      this.describeActive('using');
    } else {
      void this.resolve().catch(() => {
        // Reported by installFirst; resolve() rethrows to whoever asks next.
      });
    }
    this.scheduleUpdates();
  }

  /** Check for a newer runtime now, and say what happened. */
  async checkNow(): Promise<void> {
    if (this.active && this.active.source !== 'managed') {
      void vscode.window.showInformationMessage(
        'CodeBrain is using the runtime set in "codebrain.runtime.path", which is never updated automatically. Clear the setting to use the npm-managed runtime.',
      );
      return;
    }
    const before = this.active?.version;
    try {
      await this.update(true);
    } catch (error) {
      void vscode.window.showErrorMessage(`CodeBrain could not update CodeGraph: ${describe(error)}`);
      return;
    }
    const after = this.active?.version ?? 'runtime';
    void vscode.window.showInformationMessage(
      after !== before ? `CodeBrain updated CodeGraph to ${after}.` : `CodeGraph ${after} is up to date.`,
    );
  }

  // ---------------------------------------------------------------- sources

  private settings(): { path: string; version: string; autoUpdate: boolean; registry?: string } {
    const config = vscode.workspace.getConfiguration('codebrain.runtime');
    return {
      path: (config.get<string>('path') ?? '').trim(),
      version: (config.get<string>('version') ?? '').trim() || 'latest',
      autoUpdate: config.get<boolean>('autoUpdate', true),
      registry: normalizeRegistry(config.get<string>('registry')),
    };
  }

  /** Every source that needs no download, in priority order. */
  private localRuntime(): ActiveRuntime | undefined {
    const { path } = this.settings();
    if (path) {
      // An explicit path that is broken is an error, not a reason to quietly
      // run something else.
      return { command: describeRuntime(path), source: 'custom' };
    }

    const installed = readCurrent(this.storageRoot);
    if (installed) return this.managed(installed);
    return undefined;
  }

  private managed(installed: InstalledRuntime): ActiveRuntime {
    return { command: describeRuntime(installed.dir), source: 'managed', version: installed.version };
  }

  private describeActive(verb: string): void {
    const active = this.active;
    if (!active) return;
    const what =
      active.source === 'managed' ? `${RUNTIME_PACKAGE}@${active.version}` : 'codebrain.runtime.path';
    this.log(`[runtime] ${verb} ${what} (${active.command.command})`);
    if (active.command.repairedExecutables.length > 0) {
      this.log(`[runtime] restored the execute bit on ${active.command.repairedExecutables.join(', ')}`);
    }
  }

  /** Settings changed: switch sources, or fetch a newly pinned version. */
  private async reload(): Promise<void> {
    let next: ActiveRuntime | undefined;
    try {
      next = this.localRuntime();
      this.startupError = undefined;
    } catch (error) {
      void vscode.window.showErrorMessage(`CodeBrain: ${describe(error)}`);
      return;
    }
    if (next && next.command.command !== this.active?.command.command) {
      this.active = next;
      this.describeActive('switched to');
      this.didChange.fire();
    } else if (!next && this.active) {
      // The custom path was cleared and nothing is installed yet: fall back
      // to the managed runtime, installing it now.
      this.active = undefined;
      this.pending = undefined;
      void this.resolve().catch(() => {});
    }
    this.scheduleUpdates();
    if (this.active?.source === 'managed') {
      // The user just changed a runtime setting (often pinning a version), so
      // apply it now even with auto-update off.
      void this.update(true).catch((error) => this.log(`[runtime] update failed — ${describe(error)}`));
    }
  }

  // --------------------------------------------------------------- install

  private installFirst(): Promise<RuntimeCommand> {
    return Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `CodeBrain: installing CodeGraph (${RUNTIME_PACKAGE})…`,
        },
        async () => {
          await this.update(true);
          if (!this.active) throw new Error('the install finished without a usable runtime.');
          return this.active.command;
        },
      ),
    ).then(
        (command) => command,
        (error) => {
          // Let the next command try again instead of failing forever.
          this.pending = undefined;
          const message = `CodeBrain could not install CodeGraph: ${describe(error)}`;
          this.log(`[runtime] ${message}`);
          void vscode.window
            .showErrorMessage(message, 'Retry', 'Open Settings')
            .then((choice) => {
              if (choice === 'Retry') void this.resolve().catch(() => {});
              if (choice === 'Open Settings') {
                void vscode.commands.executeCommand('workbench.action.openSettings', 'codebrain.runtime');
              }
            });
          throw new Error(message);
        },
      );
  }

  private scheduleUpdates(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const { autoUpdate } = this.settings();
    if (!autoUpdate || (this.active && this.active.source !== 'managed')) return;

    const check = (): void => {
      void this.update(false).catch((error) => this.log(`[runtime] update check failed — ${describe(error)}`));
    };
    const first = setTimeout(check, FIRST_CHECK_DELAY_MS);
    this.disposables.push({ dispose: () => clearTimeout(first) });
    this.timer = setInterval(check, UPDATE_INTERVAL_MS);
  }

  /**
   * Bring the managed runtime to the version the settings ask for. `force`
   * runs it even with auto-update off — the first install and the explicit
   * command both need that. One run at a time; a second call joins the first.
   */
  private update(force: boolean): Promise<void> {
    if (!this.updating) {
      this.updating = this.runUpdate(force).finally(() => {
        this.updating = undefined;
      });
    }
    return this.updating;
  }

  private async runUpdate(force: boolean): Promise<void> {
    if (this.active && this.active.source !== 'managed') return;
    const settings = this.settings();
    if (!force && !settings.autoUpdate && this.active) return;

    if (!this.npm) this.npm = findNpm();
    const npm = await this.npm;
    const registry = settings.registry ?? (npm ? await npmRegistry(npm) : undefined) ?? DEFAULT_REGISTRY;
    const log = (message: string): void => this.log(`[runtime] ${message}`);

    const wanted = await resolveVersion(settings.version, { registry, npm, log });
    const previous = this.active?.version;
    if (previous === wanted) return;
    if (previous && settings.version === 'latest' && compareVersions(wanted, previous) < 0) {
      // The registry's `latest` moved backwards (a yanked release, a stale
      // mirror). Never downgrade on our own — only a pinned version does that.
      log(`registry reports ${wanted} as latest, older than the installed ${previous}; keeping ${previous}`);
      return;
    }

    log(`installing ${RUNTIME_PACKAGE}@${wanted} via ${npm ? 'npm' : registry}`);
    const installed = await installRuntime({ storageRoot: this.storageRoot, version: wanted, registry, npm, log });
    const next = this.managed(installed);
    writeCurrent(this.storageRoot, installed);

    this.active = next;
    this.describeActive(previous ? `updated ${previous} →` : 'installed');
    this.didChange.fire();

    // The previous version may still be serving an agent started before the
    // update; it goes on the next update instead.
    pruneRuntimes(this.storageRoot, [wanted, ...(previous ? [previous] : [])], log);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
