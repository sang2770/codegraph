import { basename } from 'node:path';
import * as vscode from 'vscode';
import { renderMarkdownPdf } from './pdfRenderer';
import { ReportKind, writeAndPreviewReport } from './reports';

export interface StoredReport {
  kind: ReportKind;
  title: string;
  markdown: string;
  folder: vscode.WorkspaceFolder;
  temporaryUri?: vscode.Uri;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export class ReportManager {
  private latest?: StoredReport;

  public constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.commands.registerCommand('codegraph.exportLatestMarkdown', () =>
        this.exportMarkdown(),
      ),
      vscode.commands.registerCommand('codegraph.exportLatestPdf', () =>
        this.exportPdf(),
      ),
    );
  }

  public getLatest(): StoredReport | undefined {
    return this.latest;
  }

  public async setLatest(
    report: Omit<StoredReport, 'temporaryUri'>,
    preview = true,
  ): Promise<vscode.Uri | undefined> {
    const temporaryUri = preview
      ? await writeAndPreviewReport(
          report.kind,
          report.markdown,
          report.folder,
        )
      : undefined;
    this.latest = { ...report, temporaryUri };
    await this.context.workspaceState.update('codegraph.latestReport', {
      kind: report.kind,
      title: report.title,
      markdown: report.markdown,
      folder: report.folder.uri.toString(),
      temporaryUri: temporaryUri?.toString(),
    });
    return temporaryUri;
  }

  public async exportMarkdown(): Promise<void> {
    const report = this.requireLatest();
    if (!report) return;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(
        report.folder.uri,
        `${slug(report.title) || 'codegraph-report'}.md`,
      ),
      filters: { Markdown: ['md'] },
      saveLabel: 'Export CodeGraph Markdown',
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(report.markdown, 'utf8'),
    );
    void vscode.window.showInformationMessage(
      `CodeGraph Markdown exported to ${basename(uri.fsPath)}.`,
    );
  }

  public async exportPdf(): Promise<void> {
    const report = this.requireLatest();
    if (!report) return;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(
        report.folder.uri,
        `${slug(report.title) || 'codegraph-report'}.pdf`,
      ),
      filters: { PDF: ['pdf'] },
      saveLabel: 'Export CodeGraph PDF',
    });
    if (!uri) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Exporting CodeGraph PDF',
        cancellable: false,
      },
      async () => {
        const pdf = await renderMarkdownPdf(report.markdown, {
          title: report.title,
        });
        await vscode.workspace.fs.writeFile(uri, pdf);
      },
    );
    void vscode.window.showInformationMessage(
      `CodeGraph PDF exported to ${basename(uri.fsPath)}.`,
    );
  }

  private requireLatest(): StoredReport | undefined {
    if (!this.latest) {
      void vscode.window.showWarningMessage(
        'Run CodeGraph Explain, Review, or Analyze Change Impact before exporting.',
      );
    }
    return this.latest;
  }
}
