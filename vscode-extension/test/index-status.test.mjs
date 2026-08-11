import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const { parseIndexStatus, parseIndexedFiles, buildCoverageReport, statusWarnings } =
  loadTypeScript('indexStatus.ts');

const HEALTHY = JSON.stringify({
  initialized: true,
  version: '1.2.3',
  projectPath: '/repo',
  fileCount: 120,
  nodeCount: 4_000,
  edgeCount: 9_000,
  dbSizeBytes: 1_048_576,
  languages: ['typescript', 'python'],
  pendingChanges: { added: 0, modified: 0, removed: 0 },
  index: {
    builtWithVersion: '1.2.3',
    reindexRecommended: false,
    state: 'complete',
    pendingRefs: 0,
  },
});

test('parses the runtime status payload', () => {
  const status = parseIndexStatus(HEALTHY);

  assert.equal(status.initialized, true);
  assert.equal(status.fileCount, 120);
  assert.deepEqual(status.languages, ['typescript', 'python']);
  assert.equal(status.index.state, 'complete');
});

test('survives malformed status output instead of throwing', () => {
  assert.equal(parseIndexStatus('not json'), undefined);
});

test('stays quiet about a healthy index', () => {
  assert.deepEqual(statusWarnings(parseIndexStatus(HEALTHY)), []);
});

test('warns about the silent failures that make later answers incomplete', () => {
  const status = parseIndexStatus(
    JSON.stringify({
      initialized: true,
      fileCount: 10,
      languages: [],
      pendingChanges: { added: 3, modified: 1, removed: 0 },
      index: {
        builtWithVersion: '0.9.0',
        reindexRecommended: true,
        state: 'partial',
        pendingRefs: 42,
      },
    }),
  );
  const warnings = statusWarnings(status).join(' | ');

  assert.match(warnings, /silently dropped files/);
  assert.match(warnings, /42.*unresolved/);
  assert.match(warnings, /rebuild it/i);
  assert.match(warnings, /4 file change/);
});

test('groups indexed files by language and flags tracked-only files', () => {
  const files = parseIndexedFiles(
    JSON.stringify([
      { path: './src/a.ts', language: 'typescript', nodeCount: 30 },
      { path: 'src/b.ts', language: 'typescript', nodeCount: 12 },
      { path: 'config/app.yml', language: 'yaml', nodeCount: 0 },
    ]),
  );
  const coverage = buildCoverageReport(files, []);

  assert.equal(coverage.indexedFiles, 3);
  const typescript = coverage.languages.find((item) => item.language === 'typescript');
  assert.equal(typescript.files, 2);
  assert.equal(typescript.symbols, 42);
  assert.equal(typescript.filesWithoutSymbols, 0);
  // Files with no extracted symbols cannot appear in a call path, so the panel
  // has to be able to say so.
  const yaml = coverage.languages.find((item) => item.language === 'yaml');
  assert.equal(yaml.filesWithoutSymbols, 1);
});

test('reports workspace files missing from the index, grouped by extension', () => {
  const coverage = buildCoverageReport(
    [{ path: 'src/a.ts', language: 'typescript', nodeCount: 5 }],
    ['src/a.ts', 'src/Main.kt', 'src/Other.kt', 'app/main.dart', 'README'],
  );

  assert.equal(coverage.unindexedTotal, 4);
  assert.deepEqual(coverage.unindexed, [
    { extension: '.kt', files: 2 },
    { extension: '.dart', files: 1 },
    { extension: '(no extension)', files: 1 },
  ]);
});

test('normalizes ./ prefixes so an indexed file is not reported as missing', () => {
  const coverage = buildCoverageReport(
    parseIndexedFiles(JSON.stringify([{ path: './src/a.ts', language: 'ts', nodeCount: 1 }])),
    ['./src/a.ts'],
  );

  assert.equal(coverage.unindexedTotal, 0);
});
