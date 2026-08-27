import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadTypeScript } from './helpers/load.mjs';

const { parseSubmoduleStatus } = loadTypeScript('submodules.ts', { vscode: {} });

const ROOT = resolve('/repo');

test('parses the flags git submodule status reports', () => {
  const entries = parseSubmoduleStatus(
    [
      ' 1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d libs/core (v1.4.0)',
      '-1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d libs/not-checked-out',
      '+1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d vendor/sdk (heads/main)',
      'U1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d vendor/conflicted (v2)',
    ].join('\n'),
    ROOT,
  );

  assert.deepEqual(
    entries.map((entry) => [entry.relativePath, entry.checkedOut]),
    [
      ['libs/core', true],
      ['libs/not-checked-out', false],
      ['vendor/conflicted', true],
      ['vendor/sdk', true],
    ],
  );
  assert.equal(entries[0].name, 'core');
  assert.equal(entries[0].path, join(ROOT, 'libs', 'core'));
});

test('a path containing spaces survives, and the describe tail is optional', () => {
  const entries = parseSubmoduleStatus(
    ' 1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d libs/my module\n',
    ROOT,
  );
  assert.deepEqual(
    entries.map((entry) => entry.relativePath),
    ['libs/my module'],
  );
});

test('nested submodules are listed once each', () => {
  const line = ' 1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d libs/core (v1)';
  const entries = parseSubmoduleStatus([line, line].join('\n'), ROOT);
  assert.equal(entries.length, 1);
});

test('anything that is not a status line is ignored', () => {
  const entries = parseSubmoduleStatus(
    [
      '',
      'fatal: not a git repository',
      'warning: something happened',
      // No sha at all, and a path escaping the repository: both refused.
      ' libs/core',
      '-1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d ../outside',
    ].join('\n'),
    ROOT,
  );
  assert.deepEqual(entries, []);
});

test('a submodule that already owns an index is reported as indexed', () => {
  const base = mkdtempSync(join(tmpdir(), 'codebrain-submodules-'));
  try {
    mkdirSync(join(base, 'libs', 'core', '.codegraph'), { recursive: true });
    mkdirSync(join(base, 'libs', 'fresh'), { recursive: true });
    const entries = parseSubmoduleStatus(
      [
        ' 1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d libs/core (v1)',
        ' 1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d libs/fresh (v1)',
      ].join('\n'),
      base,
    );
    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.indexed]),
      [
        ['core', true],
        ['fresh', false],
      ],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
