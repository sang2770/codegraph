import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTypeScript } from './helpers/load.mjs';

const { measureFileReadBaseline, extractContextFilePaths } =
  loadTypeScript('baseline.ts');

function withTempProject(run) {
  const root = mkdtempSync(join(tmpdir(), 'codebrain-baseline-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('measures the real on-disk cost of the candidate files', () => {
  withTempProject((root) => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'a'.repeat(4_000));
    writeFileSync(join(root, 'src/b.ts'), 'b'.repeat(2_000));

    const baseline = measureFileReadBaseline(root, ['src/a.ts', 'src/b.ts']);

    assert.equal(baseline.measured, true);
    assert.equal(baseline.measuredFiles, 2);
    assert.equal(baseline.bytes, 6_000);
    assert.equal(baseline.tokens, 1_500);
    assert.equal(baseline.unmeasuredFiles, 0);
  });
});

test('reports unmeasurable rather than guessing when no file can be read', () => {
  withTempProject((root) => {
    const baseline = measureFileReadBaseline(root, ['src/missing.ts']);

    assert.equal(baseline.measured, false);
    assert.equal(baseline.tokens, 0);
    assert.equal(baseline.unmeasuredFiles, 1);
  });
});

test('refuses to measure paths that escape the project root', () => {
  withTempProject((root) => {
    const baseline = measureFileReadBaseline(root, [
      '../../../etc/passwd',
      '/etc/passwd',
    ]);

    assert.equal(baseline.measuredFiles, 0);
    assert.equal(baseline.measured, false);
  });
});

test('counts a repeated path once', () => {
  withTempProject((root) => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'a'.repeat(400));

    const baseline = measureFileReadBaseline(root, [
      'src/a.ts',
      'src/a.ts',
      './src/a.ts',
    ]);

    assert.equal(baseline.measuredFiles, 1);
    assert.equal(baseline.bytes, 400);
  });
});

test('pulls cited file paths out of graph output and skips URLs', () => {
  const paths = extractContextFilePaths(
    [
      'Found in src/auth/session.ts:42',
      '`src/auth/token.ts` calls src/http/client.ts',
      'See https://example.com/docs/guide.html for details',
      'src/auth/session.ts again',
    ].join('\n'),
  );

  assert.deepEqual(paths, [
    'src/auth/session.ts',
    'src/auth/token.ts',
    'src/http/client.ts',
  ]);
});
