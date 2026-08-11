import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

test('reports measured savings and never invents a baseline', () => {
  const { measureTokenSaving, savingsPercent } = loadTypeScript('metrics.ts');

  const measured = measureTokenSaving({
    contextCharacters: 4_000,
    baseline: {
      measuredFiles: 12,
      unmeasuredFiles: 0,
      bytes: 48_000,
      tokens: 12_000,
      measured: true,
    },
    changedFiles: 2,
    affectedTests: 3,
    latencyMs: 125,
  });
  assert.equal(measured.contextTokens, 1_000);
  assert.equal(measured.baselineTokens, 12_000);
  assert.equal(measured.tokensSaved, 11_000);
  assert.equal(measured.baselineFiles, 12);
  assert.equal(measured.baselineMeasured, true);
  assert.equal(measured.fileReadsAvoided, 12);
  assert.equal(savingsPercent(measured), 92);
});

test('treats an unmeasurable baseline as unknown rather than as zero savings', () => {
  const { measureTokenSaving, savingsPercent } = loadTypeScript('metrics.ts');

  const sample = measureTokenSaving({
    contextCharacters: 4_000,
    baseline: {
      measuredFiles: 0,
      unmeasuredFiles: 4,
      bytes: 0,
      tokens: 0,
      measured: false,
    },
    changedFiles: 1,
    affectedTests: 0,
    latencyMs: 10,
  });
  assert.equal(sample.baselineMeasured, false);
  assert.equal(sample.baselineTokens, 0);
  assert.equal(sample.tokensSaved, 0);
  // The caller must be able to tell "unknown" from "no savings".
  assert.equal(savingsPercent(sample), undefined);
});

test('never reports a saving when the graph context is larger than the files', () => {
  const { measureTokenSaving } = loadTypeScript('metrics.ts');

  const sample = measureTokenSaving({
    contextCharacters: 100_000,
    baseline: {
      measuredFiles: 1,
      unmeasuredFiles: 0,
      bytes: 400,
      tokens: 100,
      measured: true,
    },
    changedFiles: 1,
    affectedTests: 0,
    latencyMs: 10,
  });
  assert.equal(sample.tokensSaved, 0);
});

test('classifies impact with explainable signals and a test-coverage gap', () => {
  const { classifyImpactRisk } = loadTypeScript('impact.ts');
  const result = classifyImpactRisk(
    ['src/auth.ts', 'src/session.ts', 'src/token.ts'],
    [],
    6,
    'auth permission workflow',
  );

  assert.equal(result.risk, 'critical');
  assert.equal(result.assessment.score, 8);
  assert.equal(result.assessment.maxScore, 10);
  assert.equal(result.assessment.coverage, 'gap');
  assert.equal(result.assessment.confidence, 'medium');
  assert.equal(
    JSON.stringify(result.assessment.signals.map((signal) => signal.key)),
    JSON.stringify(['sensitivity', 'blastRadius', 'changeSize', 'testCoverage']),
  );
  assert.match(result.assessment.recommendation, /tests/i);
});

test('classifies every configured impact level at its shared thresholds', () => {
  const { classifyImpactRisk, IMPACT_RISK_THRESHOLDS } = loadTypeScript('impact.ts');
  assert.equal(IMPACT_RISK_THRESHOLDS.medium, 2);
  assert.equal(classifyImpactRisk([], [], 0, '').risk, 'low');
  assert.equal(classifyImpactRisk(['a.ts', 'b.ts', 'c.ts'], ['a.test.ts'], 1, '').risk, 'medium');
  assert.equal(classifyImpactRisk(['a.ts', 'b.ts', 'c.ts'], ['a.test.ts'], 15, 'workflow').risk, 'high');
  assert.equal(classifyImpactRisk(Array.from({ length: 8 }, (_, i) => `${i}.ts`), [], 15, 'auth').risk, 'critical');
});

test('builds workflow edges from indexed dependency paths instead of a cross-product', () => {
  const { buildGraph } = loadTypeScript('impact.ts');
  const graph = buildGraph(
    ['src/SdkManager.ts', 'src/other.ts'],
    ['test/sdk.spec.ts'],
    '',
    ['src/sdk-dependent.ts', 'src/other-dependent.ts'],
    [
      { source: 'src/other.ts', target: 'src/other-dependent.ts' },
      { source: 'src/other-dependent.ts', target: 'test/sdk.spec.ts' },
    ],
  );

  assert.equal(
    JSON.stringify(graph.edges),
    JSON.stringify([
      {
        source: 'changed:src/other.ts',
        target: 'dependent:src/other-dependent.ts',
        label: 'dependency',
      },
      {
        source: 'dependent:src/other-dependent.ts',
        target: 'test:test/sdk.spec.ts',
        label: 'test evidence',
      },
    ]),
  );
  assert.equal(
    graph.edges.some(
      (edge) => edge.source === 'changed:src/SdkManager.ts' && edge.target === 'dependent:src/sdk-dependent.ts',
    ),
    false,
  );
});

test('renders a decision-focused summary and collapsed analysis details', () => {
  const { panelHtml } = loadTypeScript('impactPanel.ts');
  const analysis = {
    risk: 'high',
    changedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
    affectedTests: ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/d.test.ts'],
    totalDependentsTraversed: 281,
    directDependents: 12,
    transitiveDependents: 269,
    topWorkflows: [{ path: 'src/workflow.ts', fanOut: 48 }],
    assessment: {
      score: 4,
      maxScore: 10,
      confidence: 'high',
      coverage: 'covered',
      recommendation: 'Review the highest-fan-out workflows and run the affected test set before merging.',
      signals: [
        { key: 'sensitivity', label: 'Sensitive or contract surface', score: 0, maxScore: 3, detail: 'None.' },
        { key: 'blastRadius', label: 'Blast radius', score: 3, maxScore: 3, detail: '281 dependents.' },
        { key: 'changeSize', label: 'Change size', score: 1, maxScore: 2, detail: '5 files.' },
        { key: 'testCoverage', label: 'Missing test evidence', score: 0, maxScore: 2, detail: 'Covered.' },
      ],
    },
    nodes: [{ id: 'dependent:src/workflow.ts', label: 'workflow.ts', path: 'src/workflow.ts', kind: 'dependent' }],
    edges: [],
    metrics: { latencyMs: 125 },
  };
  const html = panelHtml({ cspSource: 'vscode-webview-resource:' }, analysis, {
    analyses: 8,
    totalLatencyMs: 1000,
    totalContextTokens: 100,
    totalBaselineTokens: 500,
    totalTokensSaved: 400,
    totalFileReadsAvoided: 3,
    last: { latencyMs: 125 },
  }, true);
  assert.match(html, /HIGH 4\/10/);
  assert.match(html, /large blast radius across 281 dependent workflows/);
  assert.match(html, /Dependent workflows/);
  assert.match(html, /Partial evidence/);
  assert.match(html, /data-graph-filter="dependent"/);
  assert.match(html, /Missing test evidence/);
  assert.match(html, /How is this calculated\?/);
  assert.match(html, /Sensitive or contract surface.*0\/3/);
  assert.match(html, /Blast radius.*3\/3/);
  assert.match(html, /Total risk score: 4\/10/);
  assert.match(html, /direct dependents/);
  assert.match(html, /Top workflows by fan-out/);
  assert.match(html, /<details class="analysis-details"><summary>Analysis details<\/summary>/);
  const summaryEnd = html.indexOf('<details class="analysis-details">');
  assert.equal(html.slice(0, summaryEnd).includes('Tokens saved'), false);
  assert.equal(html.slice(0, summaryEnd).includes('Extraction engine'), false);
});

test('builds a deterministic impact report with graph and affected tests', () => {
  const metrics = {
    estimateTokenSaving: (characters, changed, dependents, tests, latency) => ({
      contextCharacters: characters,
      contextTokens: 100,
      baselineTokens: 1000,
      tokensSaved: 900,
      fileReadsAvoided: dependents + tests,
      changedFiles: changed,
      affectedTests: tests,
      latencyMs: latency,
    }),
    MetricsStore: class {},
  };
  const { buildImpactMarkdown } = loadTypeScript('impact.ts');
  const analysis = {
    root: '/repo',
    generatedAt: '2026-01-01T00:00:00.000Z',
    runtimeTarget: 'darwin-arm64',
    nativeKernel: true,
    changedFiles: ['src/auth.ts'],
    affectedTests: ['test/auth.test.ts'],
    totalDependentsTraversed: 4,
    graphContext: '',
    risk: 'high',
    riskReasons: ['Sensitive contract.'],
    assessment: {
      score: 6,
      maxScore: 10,
      confidence: 'high',
      coverage: 'covered',
      recommendation: 'Run the affected test set before merging.',
      signals: [
        {
          key: 'sensitivity',
          label: 'Sensitive or contract surface',
          score: 3,
          maxScore: 3,
          detail: 'Sensitive contract.',
        },
      ],
    },
    depthLimit: 5,
    depthTruncated: false,
    metrics: {
      latencyMs: 125,
      contextCharacters: 400,
      contextTokens: 100,
      baselineTokens: 1000,
      baselineFiles: 4,
      baselineMeasured: true,
      tokensSaved: 900,
      fileReadsAvoided: 4,
      changedFiles: 1,
      affectedTests: 1,
    },
    nodes: [
      {
        id: 'changed:src/auth.ts',
        label: 'auth.ts',
        path: 'src/auth.ts',
        kind: 'changed',
      },
      {
        id: 'test:test/auth.test.ts',
        label: 'auth.test.ts',
        path: 'test/auth.test.ts',
        kind: 'test',
      },
    ],
    edges: [
      {
        source: 'changed:src/auth.ts',
        target: 'test:test/auth.test.ts',
        label: 'covered by',
      },
    ],
  };

  const report = buildImpactMarkdown(analysis, 'vi');
  assert.match(report, /^# Phân tích ảnh hưởng thay đổi/m);
  assert.match(report, /```mermaid/);
  assert.match(report, /test\/auth\.test\.ts/);
  // The baseline is described as measured, and names how many files back it.
  assert.match(report, /Đọc đầy đủ 4 tệp đó/);
  assert.match(report, /đo thật/);
  assert.equal(/ước tính/.test(report), false);
  // An untruncated traversal must not be hedged.
  assert.equal(report.includes('Kết quả bị cắt'), false);
});

test('marks dependent counts as a lower bound when the traversal was truncated', () => {
  const { classifyImpactRisk, buildImpactMarkdown } = loadTypeScript('impact.ts');

  const truncated = classifyImpactRisk(['src/a.ts'], ['a.test.ts'], 4, 'x'.repeat(600), {
    depthTruncated: true,
    depthLimit: 5,
  });
  const complete = classifyImpactRisk(['src/a.ts'], ['a.test.ts'], 4, 'x'.repeat(600), {
    depthTruncated: false,
    depthLimit: 5,
  });

  // Unvisited graph is exactly what could change the conclusion, so a truncated
  // traversal cannot claim high confidence.
  assert.equal(complete.assessment.confidence, 'high');
  assert.equal(truncated.assessment.confidence, 'medium');
  assert.match(truncated.reasons.join(' '), /lower bound/);
  assert.match(truncated.assessment.recommendation, /maxDepth/);
  assert.match(
    truncated.assessment.signals.find((signal) => signal.key === 'blastRadius').detail,
    /At least 4/,
  );

  const report = buildImpactMarkdown(
    {
      root: '/repo',
      generatedAt: '2026-01-01T00:00:00.000Z',
      runtimeTarget: 'linux-x64',
      nativeKernel: true,
      changedFiles: ['src/a.ts'],
      affectedTests: [],
      totalDependentsTraversed: 4,
      graphContext: '',
      risk: 'high',
      riskReasons: truncated.reasons,
      assessment: truncated.assessment,
      depthLimit: 5,
      depthTruncated: true,
      nodes: [],
      edges: [],
      metrics: {
        latencyMs: 1,
        contextCharacters: 0,
        contextTokens: 0,
        baselineTokens: 0,
        baselineFiles: 0,
        baselineMeasured: false,
        tokensSaved: 0,
        fileReadsAvoided: 0,
        changedFiles: 1,
        affectedTests: 0,
      },
    },
    'en',
  );
  assert.match(report, /This result is truncated/);
  assert.match(report, /at least 4 dependents/);
  assert.match(report, /Not measurable/);
});
