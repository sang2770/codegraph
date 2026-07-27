import * as vscode from 'vscode';
import {
  buildImpactMarkdown,
  ImpactAnalysis,
  ImpactAnalysisService,
} from './impact';
import { WorkflowGraphPanel } from './impactPanel';
import { detectResponseLanguage } from './language';
import { MetricsStore } from './metrics';
import { ReportManager } from './reportManager';
import { RuntimeCommand } from './runtime';
import { getWorkspaceFolder, hasIndex } from './workspace';

export class ImpactController implements vscode.Disposable {
  private readonly service: ImpactAnalysisService;
  private readonly disposables: vscode.Disposable[] = [];
  private latest?: ImpactAnalysis;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: RuntimeCommand,
    private readonly metrics: MetricsStore,
    private readonly reports: ReportManager,
  ) {
    this.service = new ImpactAnalysisService(this.runtime, metrics);
    this.disposables.push(
      vscode.commands.registerCommand('codebrain.analyzeImpact', () =>
        this.analyze(),
      ),
      vscode.commands.registerCommand('codebrain.openWorkflowGraph', () =>
        this.openGraph(),
      ),
      vscode.commands.registerCommand('codebrain.showTokenSavings', () =>
        this.showDashboard(),
      ),
      vscode.commands.registerCommand('codebrain.resetTokenSavings', () =>
        this.resetMetrics(),
      ),
    );
    context.subscriptions.push(...this.disposables);
  }

  public get analysisService(): ImpactAnalysisService {
    return this.service;
  }

  public get latestAnalysis(): ImpactAnalysis | undefined {
    return this.latest;
  }

  public setLatest(analysis: ImpactAnalysis): void {
    this.latest = analysis;
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  public async analyze(): Promise<ImpactAnalysis | undefined> {
    const folder = getWorkspaceFolder();
    if (!folder) {
      void vscode.window.showErrorMessage(
        'CodeBrain needs an open filesystem-backed workspace.',
      );
      return undefined;
    }
    if (!hasIndex(folder)) {
      const action = await vscode.window.showWarningMessage(
        'Initialize CodeBrain before analyzing change impact.',
        'Initialize',
      );
      if (action === 'Initialize') {
        await vscode.commands.executeCommand('codebrain.initializeWorkspace');
      }
      return undefined;
    }

    try {
      const analysis = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'CodeBrain: Analyze Change Impact',
          cancellable: true,
        },
        async (progress, token) => {
          progress.report({
            message: 'Tracing dependents and detecting affected tests…',
          });
          return this.service.analyze(folder, token);
        },
      );
      this.latest = analysis;
      const language = detectResponseLanguage('', vscode.env.language);
      const markdown = buildImpactMarkdown(analysis, language.code);
      await this.reports.setLatest(
        {
          kind: 'impact',
          title:
            language.code === 'vi'
              ? 'Phân tích ảnh hưởng thay đổi'
              : 'Change impact analysis',
          markdown,
          folder,
        },
        false,
      );
      WorkflowGraphPanel.show(
        this.context.extensionUri,
        analysis,
        this.metrics.snapshot(),
        this.runtime.nativeKernel,
      );
      return analysis;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        `CodeBrain impact analysis failed: ${message}`,
      );
      return undefined;
    }
  }

  private openGraph(): void {
    WorkflowGraphPanel.show(
      this.context.extensionUri,
      this.latest,
      this.metrics.snapshot(),
      this.runtime.nativeKernel,
    );
  }

  private showDashboard(): void {
    WorkflowGraphPanel.show(
      this.context.extensionUri,
      this.latest,
      this.metrics.snapshot(),
      this.runtime.nativeKernel,
    );
  }

  private async resetMetrics(): Promise<void> {
    const action = await vscode.window.showWarningMessage(
      'Reset CodeBrain token-saving estimates for this workspace?',
      { modal: true },
      'Reset',
    );
    if (action !== 'Reset') return;
    await this.metrics.reset();
    this.showDashboard();
  }
}
