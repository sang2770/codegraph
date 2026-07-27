import * as vscode from 'vscode';
import {
  codeBrainEnvironment,
  runCodeBrain,
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
  private readonly output = vscode.window.createOutputChannel('CodeBrain');
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(private readonly runtime: RuntimeCommand) {
    this.statusBar.command = 'codebrain.showStatus';
    this.statusBar.name = 'CodeBrain Index';
    this.statusBar.show();

    this.disposables.push(
      this.statusBar,
      this.output,
      vscode.commands.registerCommand('codebrain.initializeWorkspace', () =>
        this.initialize(),
      ),
      vscode.commands.registerCommand('codebrain.syncIndex', () => this.sync()),
      vscode.commands.registerCommand('codebrain.showStatus', () =>
        this.showStatus(),
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
    this.statusBar.text = autoRefresh
      ? '$(database) CodeBrain: Ready'
      : '$(warning) CodeBrain: Refresh off';
    this.statusBar.tooltip = autoRefresh
      ? 'Index is initialized. The bundled MCP runtime keeps it fresh while active.'
      : 'Index is initialized, but automatic refresh is disabled.';
    this.statusBar.command = 'codebrain.showStatus';
  }

  public async initialize(
    folder = getWorkspaceFolder(),
  ): Promise<boolean> {
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

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Building CodeBrain index for ${workspaceLabel(folder)}`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Parsing symbols and resolving dependencies…' });
        return runCodeBrain(this.runtime, ['init', folder.uri.fsPath], {
          cwd: folder.uri.fsPath,
          env: codeBrainEnvironment(),
        });
      },
    );

    this.logResult('init', result);
    this.refreshStatusBar();
    if (result.code !== 0) {
      void vscode.window.showErrorMessage(
        `CodeBrain initialization failed. Open the CodeBrain output channel for details.`,
      );
      this.output.show(true);
      return false;
    }

    void vscode.window.showInformationMessage(
      `CodeBrain index is ready for ${workspaceLabel(folder)}.`,
    );
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
    if (result.code !== 0) {
      void vscode.window.showErrorMessage(
        'CodeBrain refresh failed. Open the CodeBrain output channel for details.',
      );
      this.output.show(true);
      return false;
    }
    void vscode.window.showInformationMessage('CodeBrain index refreshed.');
    return true;
  }

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

    const result = await runCodeBrain(
      this.runtime,
      ['status', folder.uri.fsPath, '--json'],
      {
        cwd: folder.uri.fsPath,
        env: codeBrainEnvironment(),
      },
    );
    this.logResult('status', result);

    if (result.code !== 0) {
      void vscode.window.showErrorMessage(
        'Could not read CodeBrain status. Open the output channel for details.',
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
