import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';

export type ReportKind = 'explain' | 'review' | 'impact' | 'fix' | 'guide';

interface MermaidBlock {
  source: string;
  heading: string;
}

function fallbackDiagram(kind: ReportKind): string {
  if (kind === 'guide') {
    return [
      '```mermaid',
      'flowchart LR',
      '  P[Prerequisites] --> S[User steps]',
      '  S --> R[Expected result]',
      '  R --> T[Troubleshooting]',
      '```',
    ].join('\n');
  }
  if (kind === 'review' || kind === 'impact' || kind === 'fix') {
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
    '  E[Entry point or trigger] --> B[Business steps]',
    '  B --> D[Data and decisions]',
    '  D --> R[Result or side effects]',
    '```',
  ].join('\n');
}

function fallbackSequenceDiagram(): string {
  return [
    '```mermaid',
    'sequenceDiagram',
    '  participant U as User or system trigger',
    '  participant E as Entry point',
    '  participant C as Business workflow',
    '  participant D as Data or external dependency',
    '  U->>E: Start request',
    '  E->>C: Start business workflow',
    '  C->>D: Read or update data',
    '  D-->>C: Return result',
    '  C-->>E: Produce business result',
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

/**
 * Repair a small class of formatting damage commonly introduced when a model
 * emits nested Mermaid subgraphs. Mermaid requires each `end` statement to be
 * separate from the preceding node and from another `end`; otherwise text such
 * as `Node[Done] endend` is parsed as an invalid token.
 *
 * Keep this deliberately narrow: changing arbitrary Mermaid text can alter
 * labels or edge semantics.
 */
function normalizeMermaidBlocks(report: string): string {
  return report.replace(
    /(```mermaid\s*\n)([\s\S]*?)(```)/gi,
    (_block, opening: string, source: string, closing: string) => {
      const normalized = source
        // Two adjacent subgraph terminators need to remain two terminators.
        .replace(/\bend(?=end\b)/g, 'end\n')
        // A terminator cannot share a statement with a node declaration.
        .replace(/([)\]}])[\t ]+(?=end\b)/g, '$1\n');
      return `${opening}${normalized}${closing}`;
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
    missing.push(`### Execution sequence\n\n${fallbackSequenceDiagram()}`);
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
  let report = normalizeMermaidBlocks(rawReport.trim());
  const title =
    kind === 'review'
      ? `# Code review: ${subject || 'workspace changes'}`
      : kind === 'impact'
        ? `# Change impact: ${subject || 'workspace changes'}`
        : kind === 'fix'
          ? `# Bug analysis and solution: ${subject || 'reported issue'}`
        : kind === 'guide'
          ? `# User guide: ${subject || 'feature'}`
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
