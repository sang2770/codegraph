import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';

export type ReportKind = 'explain' | 'review' | 'impact';

function fallbackDiagram(kind: ReportKind): string {
  if (kind === 'review' || kind === 'impact') {
    return [
      '```mermaid',
      'flowchart LR',
      '  D[Changed code] --> G[CodeBrain blast radius]',
      '  G --> C[Callers and dependents]',
      '  C --> R[Regression risks]',
      '  R --> T[Required tests]',
      '```',
    ].join('\n');
  }
  return [
    '```mermaid',
    'flowchart LR',
    '  Q[Question] --> G[CodeBrain symbols]',
    '  G --> F[Function calls]',
    '  F --> W[Workflow and side effects]',
    '```',
  ].join('\n');
}

export function normalizeReport(
  kind: ReportKind,
  rawReport: string,
  subject: string,
): string {
  let report = rawReport.trim();
  const title =
    kind === 'review'
      ? `# Code review: ${subject || 'workspace changes'}`
      : kind === 'impact'
        ? `# Change impact: ${subject || 'workspace changes'}`
      : `# Workflow explanation: ${subject || 'selected code'}`;

  if (!report.startsWith('# ')) {
    report = `${title}\n\n${report}`;
  }
  if (!report.includes('```mermaid')) {
    const insertion = `\n\n## Diagram\n\n${fallbackDiagram(kind)}\n`;
    const firstSection = report.indexOf('\n## ');
    if (firstSection >= 0) {
      const nextSection = report.indexOf('\n## ', firstSection + 4);
      const at = nextSection >= 0 ? nextSection : report.length;
      report = `${report.slice(0, at)}${insertion}${report.slice(at)}`;
    } else {
      report += insertion;
    }
  }

  return `${report.trim()}\n`;
}

function safeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export async function writeAndPreviewReport(
  kind: ReportKind,
  report: string,
  folder: vscode.WorkspaceFolder,
): Promise<vscode.Uri> {
  const workspaceName = safeSegment(folder.name || basename(folder.uri.fsPath));
  const directory = vscode.Uri.file(
    join(tmpdir(), 'codebrain-vscode', workspaceName || 'workspace'),
  );
  await vscode.workspace.fs.createDirectory(directory);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const uri = vscode.Uri.joinPath(directory, `${stamp}-${kind}.md`);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(report, 'utf8'));

  const openPreview = vscode.workspace
    .getConfiguration('codebrain')
    .get<boolean>('reports.openPreview', true);
  if (openPreview) {
    await vscode.commands.executeCommand('markdown.showPreview', uri);
  }
  return uri;
}
