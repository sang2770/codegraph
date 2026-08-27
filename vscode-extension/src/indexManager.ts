import * as vscode from 'vscode';
import { IndexFreshness } from './indexFreshness';
import { parseIndexProgress } from './indexProgress';
import {
  buildCoverageReport,
  listWorkspaceFiles,
  readIndexedFiles,
  readIndexStatus,
  statusWarnings,
} from './indexStatus';
import { IndexStatusPanel } from './indexStatusPanel';
import {
  codeBrainEnvironment,
  ProcessResult,
  runCodeBrain,
  RuntimeCommand,
} from './runtime';
import {
  discoverIndexedProjects,
  getPinnedProject,
  getWorkspaceFolder,
  hasIndex,
  setPinnedProject,
  workspaceLabel,
} from './workspace';

const PINNED_PROJECT_KEY = 'codebrain.pinnedProject';

export class IndexManager implements vscode.Disposable {
  private readonly statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50,
  );
  private readonly output = vscode.window.createOutputChannel('CodeBrain');
  private readonly disposables: vscode.Disposable[] = [];
  private readonly didChange = new vscode.EventEmitter<void>();

  /**
   * Fires whenever a project gained, refreshed or lost its index, or the pinned
   * project changed — everything the modules view puts on screen.
   */
  public readonly onDidChangeIndex = this.didChange.event;

  public constructor(
    private readonly runtime: RuntimeCommand,
    private readonly context: vscode.ExtensionContext,
    private readonly freshness: IndexFreshness,
  ) {
    this.statusBar.command = 'codebrain.showStatus';
    this.statusBar.name = 'CodeBrain Index';
    this.statusBar.show();

    // Restore the project the user pinned last session before anything reads it.
    setPinnedProject(context.workspaceState.get<string>(PINNED_PROJECT_KEY));

    this.disposables.push(
      this.statusBar,
      this.output,
      this.didChange,
      vscode.commands.registerCommand('codebrain.initializeWorkspace', () =>
        this.initialize(),
      ),
      vscode.commands.registerCommand('codebrain.syncIndex', () => this.sync()),
      vscode.commands.registerCommand('codebrain.rebuildIndex', () => this.rebuild()),
      vscode.commands.registerCommand('codebrain.showStatus', () =>
        this.showStatus(),
      ),
      vscode.commands.registerCommand('codebrain.selectProject', () =>
        this.selectProject(),
      ),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshStatusBar()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshStatusBar()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codebrain.autoRefresh')) {
          this.refreshStatusBar();
        }
      }),
    );

    this.refreshStatusBar();
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  public log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  public refreshStatusBar(): void {
    const folder = getWorkspaceFolder();
    if (!folder) {
      this.statusBar.text = '$(database) CodeBrain: No workspace';
      this.statusBar.tooltip = 'Open a filesystem-backed workspace to use CodeBrain.';
      return;
    }

    if (!hasIndex(folder)) {
      this.statusBar.text = '$(database) CodeBrain: Set up';
      this.statusBar.tooltip = `Initialize the CodeBrain index for ${workspaceLabel(folder)}.`;
      this.statusBar.command = 'codebrain.initializeWorkspace';
      return;
    }

    const autoRefresh = vscode.workspace
      .getConfiguration('codebrain')
      .get<boolean>('autoRefresh.enabled', true);
    const pinned = getPinnedProject();
    const label = pinned ? ` · ${workspaceLabel(folder)}` : '';
    this.statusBar.text = autoRefresh
      ? `$(database) CodeBrain: Ready${label}`
      : `$(warning) CodeBrain: Refresh off${label}`;
    this.statusBar.tooltip = [
      autoRefresh
        ? 'Index is initialized. The bundled runtime keeps it fresh while active.'
        : 'Index is initialized, but automatic refresh is disabled.',
      pinned
        ? `Pinned project: ${pinned}`
        : 'Project follows the active editor. Use “CodeBrain: Choose Project” to pin one.',
    ].join('\n');
    this.statusBar.command = 'codebrain.showStatus';
  }

  /**
   * Pin which indexed project CodeBrain answers for.
   *
   * A monorepo can hold several indexes and there is no correct automatic
   * choice among them, so the developer needs a way to say which one they mean.
   */
  public async selectProject(): Promise<void> {
    const projects = await discoverIndexedProjects();
    if (projects.length === 0) {
      void vscode.window.showInformationMessage(
        'No initialized CodeBrain project was found in this workspace. Run “CodeBrain: Initialize Workspace” first.',
      );
      return;
    }
    const pinned = getPinnedProject();
    const items = [
      {
        label: '$(sync) Follow the active editor',
        description: pinned ? undefined : 'Current setting',
        detail: 'Use the nearest indexed project above whichever file is open',
        value: undefined as string | undefined,
      },
      ...projects.map((project) => ({
        label: `$(folder) ${project.split(/[\\/]/).pop() ?? project}`,
        description: pinned === project ? 'Current setting' : undefined,
        detail: project,
        value: project,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'CodeBrain: Choose Project',
      placeHolder: 'Which indexed project should CodeBrain analyze?',
      ignoreFocusOut: true,
    });
    if (!picked) return;
    await this.pinProject(picked.value);
  }

  /**
   * Make one project the one CodeBrain answers for, or `undefined` to follow the
   * active editor again. Persisted per workspace, so the choice survives a
   * reload the same way the picker's did.
   */
  public async pinProject(projectPath: string | undefined): Promise<void> {
    setPinnedProject(projectPath);
    await this.context.workspaceState.update(PINNED_PROJECT_KEY, projectPath);
    this.refreshStatusBar();
    this.didChange.fire();
    void vscode.window.showInformationMessage(
      projectPath
        ? `CodeBrain now answers for ${projectPath}.`
        : 'CodeBrain now follows the active editor again.',
    );
  }

  /**
   * Run a long indexing command with live progress and a working cancel button.
   */
  private async runIndexingCommand(
    args: readonly string[],
    folder: vscode.WorkspaceFolder,
    title: string,
  ): Promise<ProcessResult | undefined> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        // Indexing a large monorepo can run for minutes. Without this, a
        // mistaken start could not be stopped.
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({
          message: 'Parsing AST symbols, resolving call paths & dependencies…',
        });
        let lastPercent = 0;
        const result = await runCodeBrain(this.runtime, args, {
          cwd: folder.uri.fsPath,
          env: codeBrainEnvironment(),
          token,
          onStdout: (chunk) => {
            const update = parseIndexProgress(chunk);
            if (!update) return;
            // withProgress takes an increment, so report only the delta.
            const increment =
              update.percent !== undefined && update.percent > lastPercent
                ? update.percent - lastPercent
                : undefined;
            if (update.percent !== undefined) {
              lastPercent = Math.max(lastPercent, update.percent);
            }
            progress.report({ message: update.message, increment });
          },
        });
        if (token.isCancellationRequested) {
          return undefined;
        }
        return result;
      },
    );
  }

  public async initialize(folder = getWorkspaceFolder()): Promise<boolean> {
    if (!folder) {
      void vscode.window.showErrorMessage(
        'CodeBrain needs an open filesystem-backed workspace.',
      );
      return false;
    }
    if (hasIndex(folder)) {
      void vscode.window.showInformationMessage(
        `CodeBrain is already initialized for ${workspaceLabel(folder)}.`,
      );
      this.refreshStatusBar();
      return true;
    }

    const result = await this.runIndexingCommand(
      ['init', folder.uri.fsPath],
      folder,
      `⚡ CodeBrain: indexing ${workspaceLabel(folder)}`,
    );
    if (!result) {
      void vscode.window.showInformationMessage('CodeBrain indexing was cancelled.');
      this.refreshStatusBar();
      // A cancelled init can still have left a partial `.codegraph/` behind, so
      // the views are told to look again either way.
      this.didChange.fire();
      return false;
    }

    this.logResult('init', result);
    this.freshness.invalidate(folder.uri.fsPath);
    this.refreshStatusBar();
    this.didChange.fire();
    if (result.code !== 0) {
      void vscode.window.showErrorMessage(
        'CodeBrain initialization failed. Open the CodeBrain output channel for details.',
      );
      this.output.show(true);
      return false;
    }

    this.freshness.markFresh(folder.uri.fsPath);
    void vscode.window.showInformationMessage(
      `CodeBrain index is ready for ${workspaceLabel(folder)}.`,
    );
    return true;
  }

  /** Full rebuild, for an index the runtime reports as partial or outdated. */
  public async rebuild(folder = getWorkspaceFolder()): Promise<boolean> {
    if (!folder || !hasIndex(folder)) {
      return this.initialize(folder);
    }
    const confirmed = await vscode.window.showWarningMessage(
      `Rebuild the whole CodeBrain index for ${workspaceLabel(folder)}? On a large repository this takes as long as the first index did.`,
      { modal: true },
      'Rebuild',
    );
    if (confirmed !== 'Rebuild') return false;

    const result = await this.runIndexingCommand(
      ['index', '--path', folder.uri.fsPath],
      folder,
      `⚡ CodeBrain: rebuilding index for ${workspaceLabel(folder)}`,
    );
    if (!result) {
      void vscode.window.showInformationMessage('CodeBrain rebuild was cancelled.');
      return false;
    }
    this.logResult('index', result);
    this.freshness.invalidate(folder.uri.fsPath);
    this.didChange.fire();
    if (result.code !== 0) {
      void vscode.window.showErrorMessage(
        'CodeBrain rebuild failed. Open the CodeBrain output channel for details.',
      );
      this.output.show(true);
      return false;
    }
    this.freshness.markFresh(folder.uri.fsPath);
    void vscode.window.showInformationMessage('CodeBrain index rebuilt.');
    return true;
  }

  public async sync(folder = getWorkspaceFolder()): Promise<boolean> {
    if (!folder || !hasIndex(folder)) {
      void vscode.window.showWarningMessage(
        'Initialize CodeBrain for this workspace before refreshing the index.',
      );
      return false;
    }

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Refreshing CodeBrain index',
        cancellable: false,
      },
      () =>
        runCodeBrain(this.runtime, ['sync', folder.uri.fsPath], {
          cwd: folder.uri.fsPath,
          env: codeBrainEnvironment(),
        }),
    );

    this.logResult('sync', result);
    this.didChange.fire();
    if (result.code !== 0) {
      void vscode.window.showErrorMessage(
        'CodeBrain refresh failed. Open the CodeBrain output channel for details.',
      );
      this.output.show(true);
      return false;
    }
    this.freshness.markFresh(folder.uri.fsPath);
    void vscode.window.showInformationMessage('CodeBrain index refreshed.');
    return true;
  }

  /**
   * Show what the index actually contains, including which workspace files are
   * missing from it.
   *
   * The previous version dumped raw JSON into the output channel. That hid the
   * failure that matters most: a source language the parsers do not support is
   * simply absent from the graph, so every later answer is quietly incomplete.
   */
  public async showStatus(folder = getWorkspaceFolder()): Promise<void> {
    if (!folder) {
      void vscode.window.showInformationMessage('CodeBrain: no workspace is open.');
      return;
    }
    if (!hasIndex(folder)) {
      const action = await vscode.window.showInformationMessage(
        `CodeBrain is not initialized for ${workspaceLabel(folder)}.`,
        'Initialize',
      );
      if (action === 'Initialize') {
        await this.initialize(folder);
      }
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Reading CodeBrain index status' },
      async () => {
        const root = folder.uri.fsPath;
        const status = await readIndexStatus(this.runtime, root);
        if (!status) {
          void vscode.window.showErrorMessage(
            'Could not read CodeBrain status. Open the output channel for details.',
          );
          this.output.show(true);
          return;
        }

        const [indexedFiles, workspaceFiles] = await Promise.all([
          readIndexedFiles(this.runtime, root),
          listWorkspaceFiles(folder, root),
        ]);
        const coverage = buildCoverageReport(
          indexedFiles.files,
          workspaceFiles.paths,
          indexedFiles.truncated || workspaceFiles.truncated,
        );

        for (const warning of statusWarnings(status)) {
          this.log(`[status] ${warning}`);
        }
        IndexStatusPanel.show({ root, status, coverage }, () => {
          void this.showStatus(folder);
        });
      },
    );
  }

  private logResult(operation: string, result: ProcessResult): void {
    this.output.appendLine(`\n[${new Date().toISOString()}] codebrain (${operation})`);
    if (result.stdout.trim()) {
      this.output.appendLine(result.stdout.trimEnd());
    }
    if (result.stderr.trim()) {
      this.output.appendLine(result.stderr.trimEnd());
    }
    if (result.truncated) {
      this.output.appendLine('[output truncated]');
    }
    this.output.appendLine(`[exit ${result.code}]`);
  }
}
