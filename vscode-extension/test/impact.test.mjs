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
