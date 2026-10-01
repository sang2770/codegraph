import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTypeScript } from './helpers/load.mjs';

const { resolveToolProject, normalizeToolFiles } = loadTypeScript('lmTools.ts', { vscode: {} });

test('answers for an indexed project inside the workspace, with guidance otherwise', (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'codebrain-lm-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const service = join(workspace, 'services', 'cart');
  mkdirSync(join(service, '.codegraph'), { recursive: true });
  mkdirSync(join(service, 'src'), { recursive: true });

  assert.deepEqual(resolveToolProject({ projectPath: join(service, 'src') }, [workspace], workspace), { root: service });
  assert.match(resolveToolProject({}, [workspace], workspace).guidance, /no CodeBrain index/);
  assert.match(resolveToolProject({ projectPath: tmpdir() }, [workspace], workspace).guidance, /not inside the open VS Code workspace/);
  assert.match(resolveToolProject({}, [], undefined).guidance, /No workspace folder/);
});

test('keeps only project-relative files', () => {
  const root = join('/work', 'shop');
  assert.deepEqual(
    normalizeToolFiles(root, ['src/a.ts', join(root, 'src', 'b.ts'), '../x.ts', '/etc/passwd', '', 3, 'src/a.ts']),
    ['src/a.ts', 'src/b.ts'],
  );
});
