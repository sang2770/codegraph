import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTypeScript } from './helpers/load.mjs';

const loadReadmeContext = () => loadTypeScript('readmeContext.ts');

test('loads the nearest README and the project README for explain context', () => {
  const root = mkdtempSync(join(tmpdir(), 'codebrain-readme-'));
  try {
    mkdirSync(join(root, 'packages', 'app', 'src'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# Product\nDomain terminology.');
    writeFileSync(
      join(root, 'packages', 'app', 'README.md'),
      '# App\nApp-specific behavior.',
    );

    const { readProjectReadmeContext } = loadReadmeContext();
    const context = readProjectReadmeContext(
      root,
      'Active file: packages/app/src/main.ts',
    );

    assert.match(context, /## Project README context/);
    assert.match(context, /packages[\\/]app[\\/]README\.md/);
    assert.match(context, /App-specific behavior/);
    assert.match(context, /README\.md/);
    assert.match(context, /Domain terminology/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('returns empty context when no README exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'codebrain-readme-empty-'));
  try {
    const { readProjectReadmeContext } = loadReadmeContext();
    assert.equal(readProjectReadmeContext(root, ''), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
