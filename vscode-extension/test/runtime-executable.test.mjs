import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTypeScript } from './helpers/load.mjs';

const { ensureRuntimeExecutable, locateRuntime } = loadTypeScript('runtime.ts');

const posixOnly = { skip: process.platform === 'win32' };

/**
 * A runtime tree shaped like the one the `.vsix` ships, staged with the modes a
 * host that dropped unix file permissions would leave behind.
 */
function withRuntime(mode, run) {
  const root = mkdtempSync(join(tmpdir(), 'codebrain-runtime-'));
  try {
    const target = join(root, 'runtime', `${process.platform}-${process.arch}`);
    mkdirSync(join(target, 'bin'), { recursive: true });
    mkdirSync(join(target, 'lib', 'dist', 'bin'), { recursive: true });
    writeFileSync(join(target, 'node'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(target, 'bin', 'codegraph'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(target, 'lib', 'dist', 'bin', 'codegraph.js'), '');
    chmodSync(join(target, 'node'), mode);
    chmodSync(join(target, 'bin', 'codegraph'), mode);
    return run(target, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const permissions = (path) => statSync(path).mode & 0o777;

test('restores the execute bit an installer stripped', posixOnly, () => {
  withRuntime(0o644, (target) => {
    const repaired = ensureRuntimeExecutable(target);

    assert.deepEqual(repaired, [
      join(target, 'node'),
      join(target, 'bin', 'codegraph'),
    ]);
    assert.equal(permissions(join(target, 'node')), 0o755);
    assert.equal(permissions(join(target, 'bin', 'codegraph')), 0o755);
  });
});

test('leaves a healthy install untouched', posixOnly, () => {
  withRuntime(0o755, (target) => {
    assert.deepEqual(ensureRuntimeExecutable(target), []);
    assert.equal(permissions(join(target, 'node')), 0o755);
  });
});

test('keeps a deliberately private install private', posixOnly, () => {
  // Mirroring read bits into execute, rather than forcing 0755, means repairing
  // an owner-only runtime never widens it to every user on the machine.
  withRuntime(0o600, (target) => {
    ensureRuntimeExecutable(target);
    assert.equal(permissions(join(target, 'node')), 0o700);
  });
});

test('a missing launcher is not a permission problem', posixOnly, () => {
  withRuntime(0o755, (target) => {
    rmSync(join(target, 'bin', 'codegraph'));
    assert.deepEqual(ensureRuntimeExecutable(target), []);
  });
});

test('locating the runtime repairs it on the way', posixOnly, () => {
  withRuntime(0o644, (target, root) => {
    const runtime = locateRuntime({ fsPath: root });

    assert.equal(runtime.command, join(target, 'node'));
    assert.deepEqual(runtime.repairedExecutables, [
      join(target, 'node'),
      join(target, 'bin', 'codegraph'),
    ]);
    assert.equal(permissions(runtime.command), 0o755);
  });
});

/**
 * A non-executable file this user cannot chmod — the only way to reach the
 * unrepairable branch without root. Absent (or running as root, where every
 * chmod succeeds) the case is unreachable, so the test skips rather than
 * pretending.
 */
const foreignFile = ['/etc/hostname', '/etc/passwd'].find((path) => {
  try {
    const stats = statSync(path);
    return stats.uid !== process.getuid?.() && (stats.mode & 0o111) === 0;
  } catch {
    return false;
  }
});

test(
  'reports the exact chmod when the runtime cannot be repaired',
  { skip: posixOnly.skip || !foreignFile || process.getuid?.() === 0 },
  () => {
    withRuntime(0o755, (target) => {
      rmSync(join(target, 'node'));
      symlinkSync(foreignFile, join(target, 'node'));

      assert.throws(() => ensureRuntimeExecutable(target), (error) => {
        assert.match(error.message, /chmod \+x/);
        assert.match(error.message, /node/);
        return true;
      });
    });
  },
);

test('windows needs no repair', { skip: process.platform !== 'win32' }, () => {
  withRuntime(0o644, (target) => {
    assert.deepEqual(ensureRuntimeExecutable(target), []);
  });
});
