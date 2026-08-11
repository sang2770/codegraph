import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTypeScript } from './helpers/load.mjs';

const { findIndexedRoot } = loadTypeScript('workspace.ts');
const { isIgnoredPath } = loadTypeScript('indexFreshness.ts');

function withTemp(run) {
  const root = mkdtempSync(join(tmpdir(), 'codebrain-workspace-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('finds a sub-project index above the starting file', () => {
  withTemp((root) => {
    mkdirSync(join(root, 'packages/api/src'), { recursive: true });
    mkdirSync(join(root, 'packages/api/.codegraph'), { recursive: true });

    assert.equal(
      findIndexedRoot(join(root, 'packages/api/src'), root),
      join(root, 'packages/api'),
    );
  });
});

test('never walks above the workspace boundary', () => {
  withTemp((root) => {
    // An index outside the workspace — the shape of the runtime's own
    // ~/.codegraph directory, which exists on any machine with it installed.
    mkdirSync(join(root, '.codegraph'), { recursive: true });
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, 'src'), { recursive: true });

    // Walking up would return `root` and point every later command — git, sync,
    // explore, file measurement — at a directory outside the project.
    assert.equal(findIndexedRoot(join(workspace, 'src'), workspace), undefined);
  });
});

test('refuses a start path outside the boundary', () => {
  withTemp((root) => {
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, '.codegraph'), { recursive: true });
    mkdirSync(join(root, 'elsewhere'), { recursive: true });

    assert.equal(findIndexedRoot(join(root, 'elsewhere'), workspace), undefined);
  });
});

test('accepts the boundary itself as the indexed root', () => {
  withTemp((root) => {
    mkdirSync(join(root, '.codegraph'), { recursive: true });

    assert.equal(findIndexedRoot(root, root), root);
  });
});

test('ignores build output inside the project', () => {
  assert.equal(isIgnoredPath('dist/bundle.js'), true);
  assert.equal(isIgnoredPath('node_modules/pkg/index.js'), true);
  assert.equal(isIgnoredPath('.codegraph/codegraph.db'), true);
  assert.equal(isIgnoredPath('packages/api/dist/x.js'), true);
});

test('does not ignore source because the checkout path resembles a build dir', () => {
  // The check must run on the project-relative path. Against an absolute path,
  // a checkout at /home/me/build/app would have every change ignored, so the
  // project would never be marked stale and would silently stop refreshing.
  assert.equal(isIgnoredPath('src/index.ts'), false);
  assert.equal(isIgnoredPath('src/builder/index.ts'), false);
  assert.equal(isIgnoredPath('outbound/handler.ts'), false);
});

test('ignores anything resolving outside the project', () => {
  assert.equal(isIgnoredPath('../sibling/file.ts'), true);
  assert.equal(isIgnoredPath(''), true);
});
