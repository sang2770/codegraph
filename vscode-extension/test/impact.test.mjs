import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadTypeScript(relativePath, stubs = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name === 'node:path') return { basename: (path) => path.split('/').at(-1) };
    if (name === 'node:crypto') return { randomBytes: () => ({ toString: () => 'test-nonce' }) };
    if (name in stubs) return stubs[name];
    throw new Error(`Unexpected dependency: ${name}`);
  };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: localRequire,
    Buffer,
    console,
    process,
    setTimeout,
    clearTimeout,
  });
  return module.exports;
}

test('estimates token savings conservatively and labels baseline', () => {
  const { estimateTokenSaving } = loadTypeScript('../src/metrics.ts', {
    vscode: {},
  });
  const sample = estimateTokenSaving(4_000, 2, 8, 3, 125);
  assert.equal(sample.contextTokens, 1_000);
  assert.equal(sample.baselineTokens, 11_700);
  assert.equal(sample.tokensSaved, 10_700);
  assert.equal(sample.fileReadsAvoided, 11);
  assert.equal(sample.latencyMs, 125);
});

test('classifies impact with explainable signals and a test-coverage gap', () => {
  const { classifyImpactRisk } = loadTypeScript('../src/impact.ts', {
    vscode: {},
    './gitContext': {},
    './metrics': {},
    './runtime': {},
    './workspace': {},
  });
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
  const { classifyImpactRisk, IMPACT_RISK_THRESHOLDS } = loadTypeScript('../src/impact.ts', {
    vscode: {},
    './gitContext': {},
    './metrics': {},
    './runtime': {},
    './workspace': {},
  });
  assert.equal(IMPACT_RISK_THRESHOLDS.medium, 2);
  assert.equal(classifyImpactRisk([], [], 0, '').risk, 'low');
  assert.equal(classifyImpactRisk(['a.ts', 'b.ts', 'c.ts'], ['a.test.ts'], 1, '').risk, 'medium');
  assert.equal(classifyImpactRisk(['a.ts', 'b.ts', 'c.ts'], ['a.test.ts'], 15, 'workflow').risk, 'high');
  assert.equal(classifyImpactRisk(Array.from({ length: 8 }, (_, i) => `${i}.ts`), [], 15, 'auth').risk, 'critical');
});

test('builds workflow edges from indexed dependency paths instead of a cross-product', () => {
  const { buildGraph } = loadTypeScript('../src/impact.ts', {
    vscode: {},
    './gitContext': {},
    './metrics': {},
    './runtime': {},
    './workspace': {},
  });
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
  const { panelHtml } = loadTypeScript('../src/impactPanel.ts', {
    vscode: {},
    './impact': {
      IMPACT_RISK_THRESHOLDS: { low: 0, medium: 2, high: 4, critical: 7 },
    },
    './metrics': {},
  });
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
  const { buildImpactMarkdown } = loadTypeScript('../src/impact.ts', {
    vscode: {},
    './gitContext': {},
    './metrics': metrics,
    './runtime': {},
    './workspace': {},
  });
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
    metrics: {
      latencyMs: 125,
      contextCharacters: 400,
      contextTokens: 100,
      baselineTokens: 1000,
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
  assert.match(report, /ước tính/);
});
