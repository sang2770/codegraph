import { basename } from 'node:path';
import * as vscode from 'vscode';
import { collectGitReviewContext } from './gitContext';
import { estimateTokenSaving, MetricsStore, TokenSavingSample } from './metrics';
import {
  codeGraphEnvironment,
  runCodeGraph,
  RuntimeCommand,
} from './runtime';
import { activeEditorContext } from './workspace';

export type ImpactRisk = 'critical' | 'high' | 'medium' | 'low';
export type ImpactNodeKind = 'changed' | 'dependent' | 'test';

export interface ImpactNode {
  id: string;
  label: string;
  path: string;
  line?: number;
  kind: ImpactNodeKind;
}

export interface ImpactEdge {
  source: string;
  target: string;
  label: string;
}

export interface AffectedTestResult {
  changedFiles: string[];
  affectedTests: string[];
  totalDependentsTraversed: number;
}

export interface ImpactAnalysis {
  root: string;
  generatedAt: string;
  runtimeTarget: string;
  nativeKernel: boolean;
  changedFiles: string[];
  affectedTests: string[];
  totalDependentsTraversed: number;
  graphContext: string;
  nodes: ImpactNode[];
  edges: ImpactEdge[];
  risk: ImpactRisk;
  riskReasons: string[];
  metrics: TokenSavingSample;
}

function activeFile(folder: vscode.WorkspaceFolder): string | undefined {
  const context = activeEditorContext(folder);
  return /^Active file:\s*(.+)$/m.exec(context)?.[1]?.trim();
}

function parseAffectedJson(text: string): AffectedTestResult {
  const value = JSON.parse(text) as Partial<AffectedTestResult>;
  return {
    changedFiles: Array.isArray(value.changedFiles)
      ? value.changedFiles.filter((item): item is string => typeof item === 'string')
      : [],
    affectedTests: Array.isArray(value.affectedTests)
      ? value.affectedTests.filter((item): item is string => typeof item === 'string')
      : [],
    totalDependentsTraversed:
      typeof value.totalDependentsTraversed === 'number'
        ? value.totalDependentsTraversed
        : 0,
  };
}

function nodeId(kind: ImpactNodeKind, path: string): string {
  return `${kind}:${path}`;
}

function graphFileLocations(graphContext: string): Array<{
  path: string;
  line?: number;
}> {
  const locations = new Map<string, number | undefined>();
  const pattern =
    /(?:^|[\s*_(])((?:[\w@.-]+\/)+[\w@.+-]+\.[A-Za-z0-9]+)(?::(\d+))?/gm;
  for (const match of graphContext.matchAll(pattern)) {
    const path = match[1]?.replaceAll('\\', '/');
    if (!path || path.startsWith('http')) {
      continue;
    }
    const line = match[2] ? Number.parseInt(match[2], 10) : undefined;
    if (!locations.has(path) || line !== undefined) {
      locations.set(path, line);
    }
    if (locations.size >= 32) {
      break;
    }
  }
  return [...locations].map(([path, line]) => ({ path, line }));
}

function buildGraph(
  changedFiles: string[],
  affectedTests: string[],
  graphContext: string,
): { nodes: ImpactNode[]; edges: ImpactEdge[] } {
  const nodes = new Map<string, ImpactNode>();
  const edges: ImpactEdge[] = [];
  const changedSet = new Set(changedFiles);
  const testSet = new Set(affectedTests);

  for (const path of changedFiles) {
    nodes.set(nodeId('changed', path), {
      id: nodeId('changed', path),
      label: basename(path),
      path,
      kind: 'changed',
    });
  }
  for (const { path, line } of graphFileLocations(graphContext)) {
    if (changedSet.has(path) || testSet.has(path)) {
      continue;
    }
    nodes.set(nodeId('dependent', path), {
      id: nodeId('dependent', path),
      label: basename(path),
      path,
      line,
      kind: 'dependent',
    });
  }
  for (const path of affectedTests) {
    nodes.set(nodeId('test', path), {
      id: nodeId('test', path),
      label: basename(path),
      path,
      kind: 'test',
    });
  }

  const changed = [...nodes.values()].filter((node) => node.kind === 'changed');
  const dependents = [...nodes.values()].filter(
    (node) => node.kind === 'dependent',
  );
  const tests = [...nodes.values()].filter((node) => node.kind === 'test');

  for (const source of changed) {
    for (const target of dependents.slice(0, 12)) {
      edges.push({ source: source.id, target: target.id, label: 'may affect' });
    }
  }
  const testSources = dependents.length > 0 ? dependents.slice(0, 12) : changed;
  for (const test of tests) {
    for (const source of testSources.slice(0, 4)) {
      edges.push({ source: source.id, target: test.id, label: 'covered by' });
    }
  }

  return { nodes: [...nodes.values()], edges };
}

function classifyRisk(
  changedFiles: string[],
  affectedTests: string[],
  dependents: number,
  graphContext: string,
): { risk: ImpactRisk; reasons: string[] } {
  const scope = `${changedFiles.join(' ')} ${graphContext.slice(0, 20_000)}`;
  const sensitive =
    /\b(auth|permission|security|payment|billing|migration|schema|crypto|credential|token)\b/i.test(
      scope,
    );
  const reasons: string[] = [];
  let score = 0;

  if (sensitive) {
    score += 3;
    reasons.push('The change touches a security-, data-, or payment-sensitive area.');
  }
  if (dependents >= 15) {
    score += 3;
    reasons.push(`${dependents} transitive dependents were traversed.`);
  } else if (dependents >= 5) {
    score += 2;
    reasons.push(`${dependents} transitive dependents were traversed.`);
  } else if (dependents > 0) {
    score += 1;
    reasons.push(`${dependents} dependent workflow(s) may be affected.`);
  }
  if (changedFiles.length >= 8) {
    score += 2;
    reasons.push(`The change spans ${changedFiles.length} files.`);
  } else if (changedFiles.length >= 3) {
    score += 1;
    reasons.push(`The change spans ${changedFiles.length} files.`);
  }
  if (dependents > 0 && affectedTests.length === 0) {
    score += 2;
    reasons.push('No indexed affected tests were detected for the dependent paths.');
  } else if (affectedTests.length > 0) {
    reasons.push(`${affectedTests.length} affected test file(s) were detected.`);
  }
  if (reasons.length === 0) {
    reasons.push('The indexed blast radius is narrow.');
  }

  const risk: ImpactRisk =
    score >= 7 ? 'critical' : score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';
  return { risk, reasons };
}

function exploreQuery(changedFiles: string[]): string {
  return [
    'Analyze change impact for these files.',
    'Trace affected callers, imports, workflows, public contracts, side effects, and tests.',
    `Changed files: ${changedFiles.join(', ')}`,
  ].join(' ');
}

export class ImpactAnalysisService {
  public constructor(
    private readonly runtime: RuntimeCommand,
    private readonly metrics: MetricsStore,
  ) {}

  public async analyze(
    folder: vscode.WorkspaceFolder,
    token?: vscode.CancellationToken,
    graphContextOverride?: string,
  ): Promise<ImpactAnalysis> {
    const startedAt = Date.now();
    const config = vscode.workspace.getConfiguration('codegraph');
    const maxDiffCharacters = config.get<number>(
      'chat.maxDiffCharacters',
      120_000,
    );
    const maxFiles = config.get<number>('chat.maxContextFiles', 12);
    const depth = config.get<number>('impact.maxDepth', 5);
    const gitContext = await collectGitReviewContext(
      folder.uri.fsPath,
      maxDiffCharacters,
    );
    const changedFiles =
      gitContext.changedFiles.length > 0
        ? gitContext.changedFiles
        : [activeFile(folder)].filter((path): path is string => Boolean(path));

    if (changedFiles.length === 0) {
      throw new Error(
        'No changed file or active editor was found. Open a file or create a Git change first.',
      );
    }

    const affectedResult = await runCodeGraph(
      this.runtime,
      [
        'affected',
        ...changedFiles,
        '--path',
        folder.uri.fsPath,
        '--depth',
        String(depth),
        '--json',
      ],
      {
        cwd: folder.uri.fsPath,
        env: codeGraphEnvironment(),
        token,
      },
    );
    if (affectedResult.code !== 0) {
      throw new Error(
        affectedResult.stderr.trim() ||
          affectedResult.stdout.trim() ||
          'Affected-test detection failed.',
      );
    }
    const affected = parseAffectedJson(affectedResult.stdout);

    let graphContext = graphContextOverride;
    if (!graphContext) {
      const graphResult = await runCodeGraph(
        this.runtime,
        [
          'explore',
          exploreQuery(changedFiles),
          '--path',
          folder.uri.fsPath,
          '--max-files',
          String(maxFiles),
        ],
        {
          cwd: folder.uri.fsPath,
          env: codeGraphEnvironment(),
          token,
        },
      );
      if (graphResult.code !== 0) {
        throw new Error(
          graphResult.stderr.trim() ||
            graphResult.stdout.trim() ||
            'CodeGraph impact exploration failed.',
        );
      }
      graphContext = graphResult.stdout;
    }

    const graph = buildGraph(
      affected.changedFiles.length > 0 ? affected.changedFiles : changedFiles,
      affected.affectedTests,
      graphContext,
    );
    const classification = classifyRisk(
      changedFiles,
      affected.affectedTests,
      affected.totalDependentsTraversed,
      graphContext,
    );
    const metrics = estimateTokenSaving(
      graphContext.length + affectedResult.stdout.length,
      changedFiles.length,
      affected.totalDependentsTraversed,
      affected.affectedTests.length,
      Date.now() - startedAt,
    );
    await this.metrics.record(metrics);

    return {
      root: folder.uri.fsPath,
      generatedAt: new Date().toISOString(),
      runtimeTarget: this.runtime.target,
      nativeKernel: this.runtime.nativeKernel,
      changedFiles,
      affectedTests: affected.affectedTests,
      totalDependentsTraversed: affected.totalDependentsTraversed,
      graphContext,
      nodes: graph.nodes,
      edges: graph.edges,
      risk: classification.risk,
      riskReasons: classification.reasons,
      metrics,
    };
  }
}

function mermaidId(index: number): string {
  return `N${index}`;
}

export function impactMermaid(analysis: ImpactAnalysis): string {
  const visibleNodes = analysis.nodes.slice(0, 24);
  const ids = new Map(
    visibleNodes.map((node, index) => [node.id, mermaidId(index)]),
  );
  const lines = ['```mermaid', 'flowchart LR'];
  for (const [index, node] of visibleNodes.entries()) {
    const shape =
      node.kind === 'changed'
        ? `[Changed: ${node.label}]`
        : node.kind === 'test'
          ? `([Test: ${node.label}])`
          : `[${node.label}]`;
    lines.push(`  ${mermaidId(index)}${shape}`);
  }
  for (const edge of analysis.edges.slice(0, 40)) {
    const source = ids.get(edge.source);
    const target = ids.get(edge.target);
    if (source && target) {
      lines.push(`  ${source} -->|${edge.label}| ${target}`);
    }
  }
  lines.push('```');
  return lines.join('\n');
}

function listOrNone(values: string[], empty: string): string {
  return values.length > 0
    ? values.map((value) => `- \`${value}\``).join('\n')
    : `- ${empty}`;
}

export function buildImpactMarkdown(
  analysis: ImpactAnalysis,
  languageCode: string,
): string {
  const vi = languageCode === 'vi';
  const risk = analysis.risk.toUpperCase();
  if (vi) {
    return `# Phân tích ảnh hưởng thay đổi

## Kết luận

**Mức rủi ro: ${risk}.** CodeGraph đã duyệt ${analysis.totalDependentsTraversed} thành phần phụ thuộc và phát hiện ${analysis.affectedTests.length} tệp test bị ảnh hưởng.

${analysis.riskReasons.map((reason) => `- ${reason}`).join('\n')}

## Workflow graph

${impactMermaid(analysis)}

## Tệp thay đổi

${listOrNone(analysis.changedFiles, 'Không tìm thấy tệp thay đổi.')}

## Test bị ảnh hưởng

${listOrNone(analysis.affectedTests, 'Không phát hiện test bị ảnh hưởng trong index. Đây không phải là đảm bảo không có regression.')}

## Phạm vi ảnh hưởng

- Thành phần phụ thuộc đã duyệt: **${analysis.totalDependentsTraversed}**
- Nút hiển thị trên graph: **${analysis.nodes.length}**
- Độ trễ phân tích: **${analysis.metrics.latencyMs} ms**
- Runtime: **${analysis.runtimeTarget} · ${analysis.nativeKernel ? 'Rust native kernel' : 'WASM fallback'}**

## Tiết kiệm token (ước tính)

| Chỉ số | Giá trị |
|---|---:|
| Context CodeGraph | ${analysis.metrics.contextTokens.toLocaleString()} tokens |
| Baseline đọc tệp | ${analysis.metrics.baselineTokens.toLocaleString()} tokens |
| Token tiết kiệm | ${analysis.metrics.tokensSaved.toLocaleString()} tokens |
| Lượt đọc tệp tránh được | ${analysis.metrics.fileReadsAvoided} |

> Các số token là ước tính theo kích thước context và số tệp ứng viên, không phải số billing của model.

## Bằng chứng và giới hạn

Kết quả test và dependency được lấy từ index CodeGraph hiện tại. Hãy refresh index nếu source vừa thay đổi. Phân loại rủi ro là heuristic bảo thủ; xác nhận lại bằng test và review của con người trước khi release.
`;
  }

  return `# Change impact analysis

## Verdict

**Risk: ${risk}.** CodeGraph traversed ${analysis.totalDependentsTraversed} dependents and detected ${analysis.affectedTests.length} affected test file(s).

${analysis.riskReasons.map((reason) => `- ${reason}`).join('\n')}

## Workflow graph

${impactMermaid(analysis)}

## Changed files

${listOrNone(analysis.changedFiles, 'No changed files found.')}

## Affected tests

${listOrNone(analysis.affectedTests, 'No affected tests were detected in the index. This is not a guarantee of no regression.')}

## Blast radius

- Dependents traversed: **${analysis.totalDependentsTraversed}**
- Nodes shown in graph: **${analysis.nodes.length}**
- Analysis latency: **${analysis.metrics.latencyMs} ms**
- Runtime: **${analysis.runtimeTarget} · ${analysis.nativeKernel ? 'Rust native kernel' : 'WASM fallback'}**

## Token savings (estimated)

| Metric | Value |
|---|---:|
| CodeGraph context | ${analysis.metrics.contextTokens.toLocaleString()} tokens |
| File-reading baseline | ${analysis.metrics.baselineTokens.toLocaleString()} tokens |
| Tokens saved | ${analysis.metrics.tokensSaved.toLocaleString()} tokens |
| File reads avoided | ${analysis.metrics.fileReadsAvoided} |

> Token values are estimates based on context size and candidate-file count, not model billing data.

## Evidence and limits

Test and dependency results come from the current CodeGraph index. Refresh the index after source changes. Risk classification is a conservative heuristic; validate it with tests and human review before release.
`;
}
