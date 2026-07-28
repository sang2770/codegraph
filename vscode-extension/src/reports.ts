import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';

export type ReportKind = 'explain' | 'review' | 'impact';

interface MermaidBlock {
  source: string;
  heading: string;
}

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

function fallbackSequenceDiagram(): string {
  return [
    '```mermaid',
    'sequenceDiagram',
    '  participant U as User or caller',
    '  participant E as Entry point',
    '  participant C as Core workflow',
    '  participant D as Dependency',
    '  U->>E: Start request',
    '  E->>C: Invoke workflow',
    '  C->>D: Read or update dependency',
    '  D-->>C: Return result',
    '  C-->>E: Complete workflow',
    '  E-->>U: Return response',
    '```',
  ].join('\n');
}

function fallbackStateDiagram(): string {
  return [
    '```mermaid',
    'stateDiagram-v2',
    '  [*] --> Requested',
    '  Requested --> Processing',
    '  Processing --> Completed',
    '  Processing --> Failed',
    '  Completed --> [*]',
    '  Failed --> [*]',
    '```',
  ].join('\n');
}

function mermaidBlocks(report: string): MermaidBlock[] {
  return [...report.matchAll(/```mermaid\s*\n([\s\S]*?)```/gi)].map(
    (match) => {
      const preceding = report.slice(0, match.index ?? 0);
      const headings = [...preceding.matchAll(/^#{2,6}\s+(.+)$/gm)];
      return {
        source: match[1] ?? '',
        heading: headings.at(-1)?.[1]?.trim() ?? '',
      };
    },
  );
}

function insertDiagramSection(report: string, section: string): string {
  const insertion = `\n\n${section}\n`;
  const firstSection = report.indexOf('\n## ');
  if (firstSection < 0) {
    return report + insertion;
  }

  const nextSection = report.indexOf('\n## ', firstSection + 4);
  const at = nextSection >= 0 ? nextSection : report.length;
  return `${report.slice(0, at)}${insertion}${report.slice(at)}`;
}

function missingExplainDiagrams(report: string): string[] {
  const blocks = mermaidBlocks(report);
  const hasWorkflow = blocks.some((block) => /^\s*flowchart\b/im.test(block.source));
  const hasSequence = blocks.some((block) => /^\s*sequenceDiagram\b/im.test(block.source));
  const hasStateOrData = blocks.some(
    (block) =>
      /^\s*stateDiagram(?:-v2)?\b/im.test(block.source) ||
      (/data[\s-]*flow/i.test(block.heading) &&
        /^\s*flowchart\b/im.test(block.source)),
  );

  const missing: string[] = [];
  if (!hasWorkflow) {
    missing.push(`### Workflow flowchart\n\n${fallbackDiagram('explain')}`);
  }
  if (!hasSequence) {
    missing.push(`### Call sequence\n\n${fallbackSequenceDiagram()}`);
  }
  if (!hasStateOrData) {
    missing.push(`### State lifecycle\n\n${fallbackStateDiagram()}`);
  }
  return missing;
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
  if (kind === 'explain') {
    const missing = missingExplainDiagrams(report);
    if (missing.length > 0) {
      report = insertDiagramSection(
        report,
        `## Visual diagrams\n\n${missing.join('\n\n')}`,
      );
    }
  } else if (!report.includes('```mermaid')) {
    report = insertDiagramSection(
      report,
      `## Diagram\n\n${fallbackDiagram(kind)}`,
    );
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
