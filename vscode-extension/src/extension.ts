import * as vscode from 'vscode';
import { registerChatParticipant } from './chat';
import { ImpactController } from './impactController';
import {
  configureReviewUi,
  navigateReviewFinding,
  runIndependentReview,
} from './independentReview';
import { chooseCodeBrainModel } from './modelSelection';
import { IndexManager } from './indexManager';
import { MetricsStore } from './metrics';
import { registerMcpProvider, validateBundledRuntime } from './mcpProvider';
import { ReportManager } from './reportManager';
import { editReviewInstructions, selectReviewProfile } from './reviewInstructions';

export function activate(context: vscode.ExtensionContext): void {
  try {
    const runtime = validateBundledRuntime(context);
    configureReviewUi(context.extensionUri);
    registerMcpProvider(context, runtime);

    const indexManager = new IndexManager(runtime);
    const metrics = new MetricsStore(context);
    const reports = new ReportManager(context);
    const impactController = new ImpactController(
      context,
      runtime,
      metrics,
      reports,
    );
    context.subscriptions.push(indexManager);
    context.subscriptions.push(
      vscode.commands.registerCommand('codebrain.reviewChanges', () =>
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'CodeBrain: Reviewing your changes…',
            cancellable: true,
          },
          (_progress, token) =>
            runIndependentReview(impactController.analysisService, reports, token),
        ),
      ),
      vscode.commands.registerCommand('codebrain.selectModel', () => 
        chooseCodeBrainModel(),
      ),
      vscode.commands.registerCommand('codebrain.editReviewInstructions', () =>
        editReviewInstructions(),
      ),
      vscode.commands.registerCommand('codebrain.selectReviewProfile', () =>
        selectReviewProfile(),
      ),
      vscode.commands.registerCommand('codebrain.nextReviewFinding', () =>
        navigateReviewFinding(1),
      ),
      vscode.commands.registerCommand('codebrain.previousReviewFinding', () =>
        navigateReviewFinding(-1),
      ),
    );
    registerChatParticipant(
      context,
      runtime,
      indexManager,
      impactController,
      metrics,
      reports,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`CodeBrain extension: ${message}`);
  }
}

export function deactivate(): void {
  // Disposables registered in the extension context stop providers and UI.
}
