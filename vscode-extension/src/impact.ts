import { basename } from 'node:path';
import * as vscode from 'vscode';
import {
  extractContextFilePaths,
  measureFileReadBaseline,
} from './baseline';
import { collectGitReviewContext } from './gitContext';
import { GraphCache } from './graphCache';
import { IndexFreshness } from './indexFreshness';
import {
  measureTokenSaving,
  MetricsStore,
  savingsPercent,
  TokenSavingSample,
} from './metrics';
import {
  codeBrainEnvironment,
  runCodeBrain,
  RuntimeCommand,
} from './runtime';
import { activeEditorContext } from './workspace';

export type ImpactRisk = 'critical' | 'high' | 'medium' | 'low';
export type ImpactNodeKind = 'changed' | 'dependent' | 'test';
export type ImpactCoverage = 'covered' | 'partial' | 'gap' | 'none';

/** Shared risk thresholds used by classification and the impact explanation UI. */
export const IMPACT_RISK_THRESHOLDS: Readonly<Record<ImpactRisk, number>> = {
  low: 0,
  medium: 2,
  high: 4,
  critical: 7,
};

export interface ImpactSignal {
  key: 'sensitivity' | 'blastRadius' | 'changeSize' | 'testCoverage';
  label: string;
  score: number;
  maxScore: number;
  detail: string;
}

export interface ImpactAssessment {
  score: number;
  maxScore: number;
  confidence: 'high' | 'medium' | 'low';
  coverage: ImpactCoverage;
  signals: ImpactSignal[];
  recommendation: string;
}

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
  dependentFiles?: string[];
  dependencyEdges?: Array<{ source: string; target: string }>;
  totalDependentsTraversed: number;
  directDependents?: number;
  transitiveDependents?: number;
  topWorkflows?: Array<{ path: string; fanOut: number }>;
}

export interface ImpactAnalysis {
  root: string;
  generatedAt: string;
  runtimeTarget: string;
  nativeKernel: boolean;
  changedFiles: string[];
  affectedTests: string[];
  dependentFiles?: string[];
  dependencyEdges?: Array<{ source: string; target: string }>;
  totalDependentsTraversed: number;
  directDependents?: number;
  transitiveDependents?: number;
  topWorkflows?: Array<{ path: string; fanOut: number }>;
  graphContext: string;
  nodes: ImpactNode[];
  edges: ImpactEdge[];
  risk: ImpactRisk;
  riskReasons: string[];
  assessment: ImpactAssessment;
  metrics: TokenSavingSample;
  /** Traversal depth this analysis used (`codebrain.impact.maxDepth`). */
  depthLimit: number;
  /**
   * Whether the traversal hit `depthLimit` and stopped with more of the graph
   * still reachable. `true` means every dependent count here is a *lower
   * bound*; `undefined` means the check did not run.
   */
  depthTruncated?: boolean;
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
    dependentFiles: Array.isArray(value.dependentFiles)
      ? value.dependentFiles.filter((item): item is string => typeof item === 'string')
      : undefined,
    dependencyEdges: Array.isArray(value.dependencyEdges)
      ? value.dependencyEdges.filter(
          (item): item is { source: string; target: string } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { source?: unknown }).source === 'string' &&
            typeof (item as { target?: unknown }).target === 'string',
        )
      : undefined,
    totalDependentsTraversed:
      typeof value.totalDependentsTraversed === 'number'
        ? value.totalDependentsTraversed
        : 0,
    directDependents:
      typeof value.directDependents === 'number' ? value.directDependents : undefined,
    transitiveDependents:
      typeof value.transitiveDependents === 'number'
        ? value.transitiveDependents
        : undefined,
    topWorkflows: Array.isArray(value.topWorkflows)
      ? value.topWorkflows.filter(
          (item): item is { path: string; fanOut: number } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { path?: unknown }).path === 'string' &&
            typeof (item as { fanOut?: unknown }).fanOut === 'number',
        )
      : undefined,
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

export function buildGraph(
  changedFiles: string[],
  affectedTests: string[],
  graphContext: string,
  dependentFiles?: string[],
  dependencyEdges?: Array<{ source: string; target: string }>,
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
  const dependentLocations = dependentFiles
    ? dependentFiles.map((path) => ({ path, line: undefined }))
    : graphFileLocations(graphContext);
  for (const { path, line } of dependentLocations) {
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

  if (dependencyEdges) {
    const changedByPath = new Map(changed.map((node) => [node.path, node]));
    const dependentByPath = new Map(dependents.map((node) => [node.path, node]));
    const testByPath = new Map(tests.map((node) => [node.path, node]));
    for (const edge of dependencyEdges) {
      const source = changedByPath.get(edge.source) ?? dependentByPath.get(edge.source);
      const target = testByPath.get(edge.target) ?? dependentByPath.get(edge.target);
      if (!source || !target || source.id === target.id) continue;
      edges.push({
        source: source.id,
        target: target.id,
        label: target.kind === 'test' ? 'test evidence' : 'dependency',
      });
    }
  }

  return { nodes: [...nodes.values()], edges };
}

export function classifyImpactRisk(
  changedFiles: string[],
  affectedTests: string[],
  dependents: number,
  graphContext: string,
  traversal: { depthTruncated?: boolean; depthLimit?: number } = {},
): { risk: ImpactRisk; reasons: string[]; assessment: ImpactAssessment } {
  const scope = `${changedFiles.join(' ')} ${graphContext.slice(0, 20_000)}`;
  const sensitive =
    /\b(auth|permission|security|payment|billing|migration|schema|crypto|credential|token|public\s+api|external\s+api|endpoint)\b/i.test(
      scope,
    );
  const hasDependents = dependents > 0;
  const hasTests = affectedTests.length > 0;
  const reasons: string[] = [];
  const signals: ImpactSignal[] = [];
  let score = 0;

  const sensitivityScore = sensitive ? 3 : 0;
  signals.push({
    key: 'sensitivity',
    label: 'Sensitive or contract surface',
    score: sensitivityScore,
    maxScore: 3,
    detail: sensitive
      ? 'The changed scope contains security-, data-, payment-, or contract-sensitive terms.'
      : 'No sensitive or contract-sensitive terms were found in the indexed scope.',
  });
  if (sensitive) {
    score += sensitivityScore;
    reasons.push('The change touches a security-, data-, payment-, or public-contract-sensitive area.');
  }

  const blastRadiusScore = dependents >= 15 ? 3 : dependents >= 5 ? 2 : dependents > 0 ? 1 : 0;
  const depthLimit = traversal.depthLimit ?? 0;
  signals.push({
    key: 'blastRadius',
    label: 'Blast radius',
    score: blastRadiusScore,
    maxScore: 3,
    detail:
      dependents > 0
        ? traversal.depthTruncated
          ? `At least ${dependents} transitive dependent(s); traversal stopped at depth ${depthLimit} with more of the graph still reachable.`
          : `${dependents} transitive dependent(s) were traversed, and the traversal reached the end of the dependency chain.`
        : 'No dependent workflow was found in the current index.',
  });
  if (dependents >= 15) {
    score += blastRadiusScore;
    reasons.push(`${dependents} transitive dependents were traversed.`);
  } else if (dependents >= 5) {
    score += blastRadiusScore;
    reasons.push(`${dependents} transitive dependents were traversed.`);
  } else if (dependents > 0) {
    score += blastRadiusScore;
    reasons.push(`${dependents} dependent workflow(s) may be affected.`);
  }

  const changeSizeScore = changedFiles.length >= 8 ? 2 : changedFiles.length >= 3 ? 1 : 0;
  signals.push({
    key: 'changeSize',
    label: 'Change size',
    score: changeSizeScore,
    maxScore: 2,
    detail: `The change spans ${changedFiles.length} file(s).`,
  });
  if (changedFiles.length >= 8) {
    score += changeSizeScore;
    reasons.push(`The change spans ${changedFiles.length} files.`);
  } else if (changedFiles.length >= 3) {
    score += changeSizeScore;
    reasons.push(`The change spans ${changedFiles.length} files.`);
  }

  const coverageScore = hasDependents && !hasTests ? 2 : 0;
  const coverage: ImpactCoverage = hasDependents
    ? hasTests
      ? affectedTests.length >= Math.min(dependents, 3)
        ? 'covered'
        : 'partial'
      : 'gap'
    : 'none';
  signals.push({
    key: 'testCoverage',
    label: 'Missing test evidence',
    score: coverageScore,
    maxScore: 2,
    detail:
      coverage === 'gap'
        ? 'No indexed affected tests were detected for the dependent paths.'
        : hasTests
          ? `${affectedTests.length} affected test file(s) were detected (${coverage} coverage signal).`
          : 'There is no dependent workflow requiring affected-test evidence.',
  });
  if (coverage === 'gap') {
    score += coverageScore;
    reasons.push('No indexed affected tests were detected for the dependent paths.');
  } else if (hasTests) {
    reasons.push(`${affectedTests.length} affected test file(s) were detected.`);
  }
  if (traversal.depthTruncated) {
    reasons.push(
      `The dependency traversal stopped at its depth limit of ${depthLimit}, so every dependent count above is a lower bound rather than the full blast radius.`,
    );
  }
  if (reasons.length === 0) {
    reasons.push('The indexed blast radius is narrow.');
  }

  const risk: ImpactRisk =
    score >= IMPACT_RISK_THRESHOLDS.critical
      ? 'critical'
      : score >= IMPACT_RISK_THRESHOLDS.high
        ? 'high'
        : score >= IMPACT_RISK_THRESHOLDS.medium
          ? 'medium'
          : 'low';
  const measuredConfidence: ImpactAssessment['confidence'] =
    graphContext.length >= 500 && (hasDependents || hasTests)
      ? 'high'
      : graphContext.length > 0
        ? 'medium'
        : 'low';
  // A truncated traversal cannot support high confidence: the part of the graph
  // we never visited is exactly the part that could change the conclusion.
  const confidence: ImpactAssessment['confidence'] =
    traversal.depthTruncated && measuredConfidence === 'high'
      ? 'medium'
      : measuredConfidence;
  const recommendation = traversal.depthTruncated
    ? `Raise codebrain.impact.maxDepth above ${depthLimit} to see the full blast radius before merging; the current result is a lower bound.`
    : coverage === 'gap'
      ? 'Run or add tests for the affected workflows before merging.'
      : risk === 'critical' || risk === 'high'
        ? 'Review the highest-fan-out workflows and run the affected test set before merging.'
        : risk === 'medium'
          ? 'Review the listed dependents and run the affected tests before merging.'
          : 'Run the affected tests and confirm the narrow blast radius in review.';

  return {
    risk,
    reasons,
    assessment: {
      score,
      maxScore: 10,
      confidence,
      coverage,
      signals,
      recommendation,
    },
  };
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
    private readonly freshness: IndexFreshness,
    private readonly exploreCache = new GraphCache<string>(),
  ) {}

  /** One `affected` run at a given traversal depth. */
  private async runAffected(
    root: string,
    changedFiles: readonly string[],
    depth: number,
    token?: vscode.CancellationToken,
  ): Promise<AffectedTestResult> {
    const result = await runCodeBrain(
      this.runtime,
      [
        'affected',
        ...changedFiles,
        '--path',
        root,
        '--depth',
        String(depth),
        '--json',
      ],
      {
        cwd: root,
        env: codeBrainEnvironment(),
        token,
      },
    );
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          'Affected-test detection failed.',
      );
    }
    return parseAffectedJson(result.stdout);
  }

  public async analyze(
    folder: vscode.WorkspaceFolder,
    token?: vscode.CancellationToken,
    graphContextOverride?: string,
  ): Promise<ImpactAnalysis> {
    const startedAt = Date.now();
    const config = vscode.workspace.getConfiguration('codebrain');
    const maxDiffCharacters = config.get<number>(
      'chat.maxDiffCharacters',
      120_000,
    );
    const maxFiles = config.get<number>('chat.maxContextFiles', 12);
    const depth = config.get<number>('impact.maxDepth', 5);
    const detectTruncation = config.get<boolean>(
      'impact.detectDepthTruncation',
      true,
    );
    // Chat impact requests already refreshed while collecting their graph
    // context, so they pass it back as an override. Everything else refreshes
    // here — and only when the workspace actually changed since the last sync.
    if (!graphContextOverride) {
      await this.freshness.ensureFresh(folder, token);
    }
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

    // Probe one level deeper in parallel. If the deeper run reaches more of the
    // graph, the configured depth cut the traversal short — which means every
    // dependent count below is a lower bound, and a reader who takes "3
    // dependents" at face value is being misled. Running both concurrently
    // keeps the wall-clock cost of knowing this at roughly zero.
    const [affected, deeperProbe] = await Promise.all([
      this.runAffected(folder.uri.fsPath, changedFiles, depth, token),
      detectTruncation
        ? this.runAffected(folder.uri.fsPath, changedFiles, depth + 1, token).catch(
            () => undefined,
          )
        : Promise.resolve(undefined),
    ]);
    const depthTruncated = deeperProbe
      ? deeperProbe.totalDependentsTraversed > affected.totalDependentsTraversed
      : undefined;

    let graphContext = graphContextOverride;
    if (!graphContext) {
      const cacheKey = {
        root: folder.uri.fsPath,
        kind: 'explore:impact',
        parts: [exploreQuery(changedFiles), maxFiles],
      };
      const generation = this.freshness.generation(folder.uri.fsPath);
      const cached = this.exploreCache.get(cacheKey, generation);
      if (cached !== undefined) {
        graphContext = cached;
      } else {
        const graphResult = await runCodeBrain(
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
            env: codeBrainEnvironment(),
            token,
          },
        );
        if (graphResult.code !== 0) {
          throw new Error(
            graphResult.stderr.trim() ||
              graphResult.stdout.trim() ||
              'CodeBrain impact exploration failed.',
          );
        }
        graphContext = graphResult.stdout;
        this.exploreCache.set(cacheKey, generation, graphContext);
      }
    }

    const graph = buildGraph(
      affected.changedFiles.length > 0 ? affected.changedFiles : changedFiles,
      affected.affectedTests,
      graphContext,
      affected.dependentFiles,
      affected.dependencyEdges,
    );
    const dependentCount = affected.dependentFiles?.length ?? affected.totalDependentsTraversed;
    const classification = classifyImpactRisk(
      changedFiles,
      affected.affectedTests,
      dependentCount,
      graphContext,
      { depthTruncated, depthLimit: depth },
    );
    // Measure the real cost of reading the files CodeBrain answered *instead*
    // of. Changed files are excluded: they are in the diff either way, so they
    // are not a read the graph saved.
    const changedSet = new Set(changedFiles);
    const candidateFiles = [
      ...(affected.dependentFiles ?? []),
      ...affected.affectedTests,
      ...extractContextFilePaths(graphContext),
    ].filter((path) => !changedSet.has(path));
    const metrics = measureTokenSaving({
      contextCharacters: graphContext.length,
      baseline: measureFileReadBaseline(folder.uri.fsPath, candidateFiles),
      changedFiles: changedFiles.length,
      affectedTests: affected.affectedTests.length,
      latencyMs: Date.now() - startedAt,
    });
    await this.metrics.record(metrics);

    return {
      depthLimit: depth,
      depthTruncated,
      root: folder.uri.fsPath,
      generatedAt: new Date().toISOString(),
      runtimeTarget: this.runtime.target,
      nativeKernel: this.runtime.nativeKernel,
      changedFiles,
      affectedTests: affected.affectedTests,
      dependentFiles: affected.dependentFiles,
      dependencyEdges: affected.dependencyEdges,
      totalDependentsTraversed: affected.totalDependentsTraversed,
      directDependents: affected.directDependents,
      transitiveDependents: affected.transitiveDependents,
      topWorkflows: affected.topWorkflows,
      graphContext,
      nodes: graph.nodes,
      edges: graph.edges,
      risk: classification.risk,
      riskReasons: classification.reasons,
      assessment: classification.assessment,
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

function assessmentFor(analysis: ImpactAnalysis): ImpactAssessment {
  if (analysis.assessment) {
    return analysis.assessment;
  }
  const scoreByRisk: Record<ImpactRisk, number> = {
    low: 1,
    medium: 3,
    high: 6,
    critical: 9,
  };
  return {
    score: scoreByRisk[analysis.risk],
    maxScore: 10,
    confidence: 'low',
    coverage:
      analysis.totalDependentsTraversed === 0
        ? 'none'
        : analysis.affectedTests.length > 0
          ? 'partial'
          : 'gap',
    signals: analysis.riskReasons.map((detail, index) => ({
      key: index === 0 ? 'sensitivity' : 'blastRadius',
      label: 'Risk signal',
      score: 1,
      maxScore: 1,
      detail,
    })),
    recommendation: 'Validate the affected workflows with tests and human review.',
  };
}

function coverageLabel(coverage: ImpactCoverage, vi: boolean): string {
  if (vi) {
    return {
      covered: 'Có test bao phủ',
      partial: 'Bao phủ một phần',
      gap: 'Thiếu test ảnh hưởng',
      none: 'Không có dependent',
    }[coverage];
  }
  return {
    covered: 'Covered by indexed tests',
    partial: 'Partially covered',
    gap: 'Test coverage gap',
    none: 'No dependent workflow',
  }[coverage];
}

function confidenceLabel(confidence: ImpactAssessment['confidence'], vi: boolean): string {
  if (vi) {
    return { high: 'Cao', medium: 'Trung bình', low: 'Thấp' }[confidence];
  }
  return { high: 'High', medium: 'Medium', low: 'Low' }[confidence];
}

function signalTable(assessment: ImpactAssessment, vi: boolean): string {
  const header = vi
    ? '| Tín hiệu | Điểm đóng góp | Bằng chứng |\n|---|---:|---|'
    : '| Signal | Contribution | Evidence |\n|---|---:|---|';
  const rows = assessment.signals.map(
    (signal) => `| ${signal.label} | **${signal.score}/${signal.maxScore}** | ${signal.detail} |`,
  );
  return [header, ...rows].join('\n');
}

/** Explicit warning when the traversal stopped early, or empty when it did not. */
function truncationNotice(analysis: ImpactAnalysis, vi: boolean): string {
  if (analysis.depthTruncated !== true) {
    return '';
  }
  return vi
    ? `> ⚠️ **Kết quả bị cắt.** Việc duyệt phụ thuộc đã dừng ở giới hạn độ sâu **${analysis.depthLimit}** trong khi vẫn còn phần đồ thị chưa đi tới. Mọi con số dependent bên dưới là **giới hạn dưới**, không phải blast radius đầy đủ. Tăng \`codebrain.impact.maxDepth\` để thấy toàn bộ.\n`
    : `> ⚠️ **This result is truncated.** The dependency traversal stopped at its depth limit of **${analysis.depthLimit}** while more of the graph was still reachable. Every dependent count below is a **lower bound**, not the full blast radius. Raise \`codebrain.impact.maxDepth\` to see the rest.\n`;
}

/** Token section that reports a measured comparison, or says it cannot. */
function tokenSection(analysis: ImpactAnalysis, vi: boolean): string {
  const metrics = analysis.metrics;
  if (!metrics.baselineMeasured) {
    return vi
      ? `Không đo được: CodeBrain không tìm thấy tệp ứng viên nào để so sánh, nên phần tiết kiệm là **không xác định** (không phải bằng 0).`
      : `Not measurable: CodeBrain found no candidate file to compare against, so savings are **unknown** (not zero).`;
  }
  const percent = savingsPercent(metrics);
  const rows = vi
    ? [
        '| Chỉ số | Giá trị |',
        '|---|---:|',
        `| Context CodeBrain trả về | ${metrics.contextTokens.toLocaleString()} tokens |`,
        `| Đọc đầy đủ ${metrics.baselineFiles} tệp đó | ${metrics.baselineTokens.toLocaleString()} tokens |`,
        `| Chênh lệch | ${metrics.tokensSaved.toLocaleString()} tokens${percent !== undefined ? ` (~${percent}%)` : ''} |`,
      ]
    : [
        '| Metric | Value |',
        '|---|---:|',
        `| Context CodeBrain returned | ${metrics.contextTokens.toLocaleString()} tokens |`,
        `| Reading those ${metrics.baselineFiles} files in full | ${metrics.baselineTokens.toLocaleString()} tokens |`,
        `| Difference | ${metrics.tokensSaved.toLocaleString()} tokens${percent !== undefined ? ` (~${percent}%)` : ''} |`,
      ];
  const note = vi
    ? `> Baseline được **đo thật** từ kích thước trên đĩa của ${metrics.baselineFiles} tệp mà CodeBrain lấy bằng chứng, quy đổi 4 byte ≈ 1 token. Không phải dữ liệu billing của model.`
    : `> The baseline is **measured** from the real on-disk size of the ${metrics.baselineFiles} files CodeBrain drew evidence from, converted at 4 bytes ≈ 1 token. It is not model billing data.`;
  return [...rows, '', note].join('\n');
}

export function buildImpactMarkdown(
  analysis: ImpactAnalysis,
  languageCode: string,
): string {
  const vi = languageCode === 'vi';
  const assessment = assessmentFor(analysis);
  const risk = analysis.risk.toUpperCase();
  if (vi) {
    return `# Phân tích ảnh hưởng thay đổi

${truncationNotice(analysis, true)}
## Kết luận

**Mức độ ảnh hưởng: ${risk} (${assessment.score}/${assessment.maxScore}).** CodeBrain đã duyệt ${analysis.depthTruncated === true ? 'ít nhất ' : ''}${analysis.totalDependentsTraversed} thành phần phụ thuộc và phát hiện ${analysis.affectedTests.length} tệp test bị ảnh hưởng.

- Độ tin cậy bằng chứng: **${confidenceLabel(assessment.confidence, true)}**
- Tình trạng test: **${coverageLabel(assessment.coverage, true)}**

${analysis.riskReasons.map((reason) => `- ${reason}`).join('\n')}

## Vì sao có mức độ này?

${signalTable(assessment, true)}

## Khuyến nghị

${assessment.recommendation}

## Workflow graph

${impactMermaid(analysis)}

## Tệp thay đổi

${listOrNone(analysis.changedFiles, 'Không tìm thấy tệp thay đổi.')}

## Test bị ảnh hưởng

${listOrNone(analysis.affectedTests, 'Không phát hiện test bị ảnh hưởng trong index. Đây không phải là đảm bảo không có regression.')}

## Phạm vi ảnh hưởng

- Tệp thay đổi: **${analysis.changedFiles.length}**
- Thành phần phụ thuộc đã duyệt: **${analysis.depthTruncated === true ? '≥ ' : ''}${analysis.totalDependentsTraversed}**
- Test bị ảnh hưởng: **${analysis.affectedTests.length}**
- Nút hiển thị trên graph: **${analysis.nodes.length}**
- Giới hạn độ sâu: **${analysis.depthLimit}**${analysis.depthTruncated === true ? ' (đã bị cắt)' : analysis.depthTruncated === false ? ' (chưa bị cắt)' : ''}
- Độ trễ phân tích: **${analysis.metrics.latencyMs} ms**
- Runtime: **${analysis.runtimeTarget} · ${analysis.nativeKernel ? 'Rust native kernel' : 'WASM fallback'}**

## So sánh chi phí context

${tokenSection(analysis, true)}

## Bằng chứng và giới hạn

Kết quả test và dependency được lấy từ index CodeBrain hiện tại. Hãy refresh index nếu source vừa thay đổi. Phân loại rủi ro là heuristic bảo thủ; xác nhận lại bằng test và review của con người trước khi release.
`;
  }

  return `# Change impact analysis

${truncationNotice(analysis, false)}
## Verdict

**Impact level: ${risk} (${assessment.score}/${assessment.maxScore}).** CodeBrain traversed ${analysis.depthTruncated === true ? 'at least ' : ''}${analysis.totalDependentsTraversed} dependents and detected ${analysis.affectedTests.length} affected test file(s).

- Evidence confidence: **${confidenceLabel(assessment.confidence, false)}**
- Test status: **${coverageLabel(assessment.coverage, false)}**

${analysis.riskReasons.map((reason) => `- ${reason}`).join('\n')}

## Why this level?

${signalTable(assessment, false)}

## Recommendation

${assessment.recommendation}

## Workflow graph

${impactMermaid(analysis)}

## Changed files

${listOrNone(analysis.changedFiles, 'No changed files found.')}

## Affected tests

${listOrNone(analysis.affectedTests, 'No affected tests were detected in the index. This is not a guarantee of no regression.')}

## Blast radius

- Changed files: **${analysis.changedFiles.length}**
- Dependents traversed: **${analysis.depthTruncated === true ? '≥ ' : ''}${analysis.totalDependentsTraversed}**
- Affected tests: **${analysis.affectedTests.length}**
- Nodes shown in graph: **${analysis.nodes.length}**
- Depth limit: **${analysis.depthLimit}**${analysis.depthTruncated === true ? ' (reached — result truncated)' : analysis.depthTruncated === false ? ' (not reached)' : ''}
- Analysis latency: **${analysis.metrics.latencyMs} ms**
- Runtime: **${analysis.runtimeTarget} · ${analysis.nativeKernel ? 'Rust native kernel' : 'WASM fallback'}**

## Context cost comparison

${tokenSection(analysis, false)}

## Evidence and limits

Test and dependency results come from the current CodeBrain index. Refresh the index after source changes. Risk classification is a conservative heuristic; validate it with tests and human review before release.
`;
}
