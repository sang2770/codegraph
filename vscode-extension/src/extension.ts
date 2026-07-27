import * as vscode from 'vscode';
import { registerChatParticipant } from './chat';
import { ImpactController } from './impactController';
import { IndexManager } from './indexManager';
import { MetricsStore } from './metrics';
import { registerMcpProvider, validateBundledRuntime } from './mcpProvider';
import { ReportManager } from './reportManager';

export function activate(context: vscode.ExtensionContext): void {
  try {
    const runtime = validateBundledRuntime(context);
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
    registerChatParticipant(
      context,
      runtime,
      indexManager,
      impactController,
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
