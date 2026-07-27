import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertTarget,
  normalizeTarget,
  SUPPORTED_TARGETS,
} from '../scripts/runtime-target.mjs';

test('normalizes supported VS Code runtime targets', () => {
  assert.equal(normalizeTarget('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(normalizeTarget('linux', 'x64'), 'linux-x64');
  assert.equal(normalizeTarget('win32', 'arm64'), 'win32-arm64');
});

test('rejects unsupported runtime targets', () => {
  assert.throws(() => normalizeTarget('freebsd', 'x64'), /Unsupported/);
  assert.throws(() => normalizeTarget('linux', 'ia32'), /Unsupported/);
  assert.throws(() => assertTarget('darwin-ia32'), /Unsupported/);
});

test('keeps the build matrix explicit', () => {
  assert.deepEqual(SUPPORTED_TARGETS, [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-arm64',
    'win32-x64',
  ]);
});
