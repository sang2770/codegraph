import * as vscode from 'vscode';
import {
  codeGraphEnvironment,
  runCodeGraph,
  RuntimeCommand,
} from './runtime';
import {
  getWorkspaceFolder,
  hasIndex,
  workspaceLabel,
} from './workspace';

export class IndexManager implements vscode.Disposable {
  private readonly statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50,
  );
  private readonly output = vscode.window.createOutputChannel('CodeGraph');
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(private readonly runtime: RuntimeCommand) {
    this.statusBar.command = 'codegraph.showStatus';
    this.statusBar.name = 'CodeGraph Index';
    this.statusBar.show();

    this.disposables.push(
      this.statusBar,
      this.output,
      vscode.commands.registerCommand('codegraph.initializeWorkspace', () =>
        this.initialize(),
      ),
      vscode.commands.registerCommand('codegraph.syncIndex', () => this.sync()),
      vscode.commands.registerCommand('codegraph.showStatus', () =>
        this.showStatus(),
      ),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshStatusBar()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshStatusBar()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codegraph.autoRefresh')) {
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

  public refreshStatusBar(): void {
    const folder = getWorkspaceFolder();
    if (!folder) {
      this.statusBar.text = '$(database) CodeGraph: No workspace';
      this.statusBar.tooltip = 'Open a filesystem-backed workspace to use CodeGraph.';
      return;
    }

    if (!hasIndex(folder)) {
      this.statusBar.text = '$(database) CodeGraph: Set up';
      this.statusBar.tooltip = `Initialize the CodeGraph index for ${workspaceLabel(folder)}.`;
      this.statusBar.command = 'codegraph.initializeWorkspace';
      return;
    }

    const autoRefresh = vscode.workspace
      .getConfiguration('codegraph')
      .get<boolean>('autoRefresh.enabled', true);
    this.statusBar.text = autoRefresh
      ? '$(database) CodeGraph: Ready'
      : '$(warning) CodeGraph: Refresh off';
    this.statusBar.tooltip = autoRefresh
      ? 'Index is initialized. The bundled MCP runtime keeps it fresh while active.'
      : 'Index is initialized, but automatic refresh is disabled.';
    this.statusBar.command = 'codegraph.showStatus';
  }

  public async initialize(
    folder = getWorkspaceFolder(),
  ): Promise<boolean> {
    if (!folder) {
      void vscode.window.showErrorMessage(
        'CodeGraph needs an open filesystem-backed workspace.',
      );
      return false;
    }
    if (hasIndex(folder)) {
      void vscode.window.showInformationMessage(
        `CodeGraph is already initialized for ${workspaceLabel(folder)}.`,
      );
      this.refreshStatusBar();
      return true;
    }

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Building CodeGraph index for ${workspaceLabel(folder)}`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Parsing symbols and resolving dependencies…' });
        return runCodeGraph(this.runtime, ['init', folder.uri.fsPath], {
          cwd: folder.uri.fsPath,
          env: codeGraphEnvironment(),
        });
      },
    );

    this.logResult('init', result);
    this.refreshStatusBar();
    if (result.code !== 0) {
      void vscode.window.showErrorMessage(
        `CodeGraph initialization failed. Open the CodeGraph output channel for details.`,
      );
      this.output.show(true);
      return false;
    }

    void vscode.window.showInformationMessage(
      `CodeGraph index is ready for ${workspaceLabel(folder)}.`,
    );
    return true;
  }

  public async sync(folder = getWorkspaceFolder()): Promise<boolean> {
    if (!folder || !hasIndex(folder)) {
      void vscode.window.showWarningMessage(
        'Initialize CodeGraph for this workspace before refreshing the index.',
      );
      return false;
    }

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Refreshing CodeGraph index',
        cancellable: false,
      },
      () =>
        runCodeGraph(this.runtime, ['sync', folder.uri.fsPath], {
          cwd: folder.uri.fsPath,
          env: codeGraphEnvironment(),
        }),
    );

    this.logResult('sync', result);
    if (result.code !== 0) {
      void vscode.window.showErrorMessage(
        'CodeGraph refresh failed. Open the CodeGraph output channel for details.',
      );
      this.output.show(true);
      return false;
    }
    void vscode.window.showInformationMessage('CodeGraph index refreshed.');
    return true;
  }

  public async showStatus(folder = getWorkspaceFolder()): Promise<void> {
    if (!folder) {
      void vscode.window.showInformationMessage('CodeGraph: no workspace is open.');
      return;
    }
    if (!hasIndex(folder)) {
      const action = await vscode.window.showInformationMessage(
        `CodeGraph is not initialized for ${workspaceLabel(folder)}.`,
        'Initialize',
      );
      if (action === 'Initialize') {
        await this.initialize(folder);
      }
      return;
    }

    const result = await runCodeGraph(
      this.runtime,
      ['status', folder.uri.fsPath, '--json'],
      {
        cwd: folder.uri.fsPath,
        env: codeGraphEnvironment(),
      },
    );
    this.logResult('status', result);

    if (result.code !== 0) {
      void vscode.window.showErrorMessage(
        'Could not read CodeGraph status. Open the output channel for details.',
      );
      this.output.show(true);
      return;
    }

    this.output.show(true);
  }

  private logResult(
    operation: string,
    result: {
      code: number;
      stdout: string;
      stderr: string;
      truncated: boolean;
    },
  ): void {
    this.output.appendLine(`\n[${new Date().toISOString()}] codegraph ${operation}`);
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
