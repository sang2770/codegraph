import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function loadReadmeContext() {
  const source = readFileSync(
    new URL('../src/readmeContext.ts', import.meta.url),
    'utf8',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: (name) => {
      if (name === 'node:fs') return require('node:fs');
      if (name === 'node:path') return require('node:path');
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return module.exports;
}

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
