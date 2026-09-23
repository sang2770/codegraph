import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { loadTypeScript } from './helpers/load.mjs';

const posixOnly = { skip: process.platform === 'win32' };
const target = `${process.platform}-${process.arch}`;

/** Just enough of the `vscode` API for the manager: settings, events, notifications. */
function stubVscode(settings = {}) {
  const errors = [];
  class EventEmitter {
    listeners = [];
    event = (listener) => {
      this.listeners.push(listener);
      return { dispose() {} };
    };
    fire() {
      for (const listener of this.listeners) listener();
    }
    dispose() {}
  }
  const vscode = {
    EventEmitter,
    ProgressLocation: { Notification: 15 },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => (key in settings ? settings[key] : fallback) }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    window: {
      withProgress: (_options, task) => task({ report() {} }),
      showErrorMessage: (message) => {
        errors.push(message);
        return Promise.resolve(undefined);
      },
      showInformationMessage: () => Promise.resolve(undefined),
    },
    commands: { executeCommand: () => Promise.resolve() },
  };
  return { vscode, errors };
}

/** A fake `npm` on PATH that "installs" the platform package under --prefix. */
function withFakeNpm(root, run) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('10.0.0'); process.exit(0); }
if (args[0] === 'view') { process.stdout.write('"1.6.1"'); process.exit(0); }
if (args[0] === 'install') {
  const dir = path.join(args[args.indexOf('--prefix') + 1], 'node_modules', '@xuansang2770', 'codegraph-${target}');
  fs.mkdirSync(path.join(dir, 'lib', 'dist', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node'), '');
  fs.chmodSync(path.join(dir, 'node'), 0o755);
  fs.writeFileSync(path.join(dir, 'lib', 'dist', 'bin', 'codegraph.js'), '');
  process.exit(0);
}
process.exit(1);
`,
  );
  chmodSync(join(bin, 'npm'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous}`;
  return Promise.resolve(run()).finally(() => {
    process.env.PATH = previous;
  });
}

function context(root) {
  const extension = join(root, 'extension');
  mkdirSync(extension, { recursive: true });
  return {
    globalStorageUri: { fsPath: join(root, 'storage') },
    extensionUri: { fsPath: extension },
  };
}

function load(settings) {
  const { vscode, errors } = stubVscode(settings);
  const { RuntimeManager } = loadTypeScript('runtimeManager.ts', { vscode });
  return { RuntimeManager, errors };
}

test('the first start installs from npm, and the next start reuses it offline', posixOnly, async () => {
  const root = mkdtempSync(join(tmpdir(), 'codebrain-manager-'));
  try {
    await withFakeNpm(root, async () => {
      const { RuntimeManager } = load();
      const manager = new RuntimeManager(context(root), () => {});
      let changes = 0;
      manager.onDidChange(() => (changes += 1));

      manager.start();
      assert.equal(manager.current(), undefined, 'nothing to run until the install lands');
      const runtime = await manager.resolve();
      manager.dispose();

      const expected = join(root, 'storage', 'runtime', '1.6.1', 'node_modules', '@xuansang2770', `codegraph-${target}`);
      assert.equal(runtime.command, join(expected, 'node'));
      assert.equal(manager.currentVersion(), '1.6.1');
      assert.equal(changes, 1);
      const pointer = JSON.parse(readFileSync(join(root, 'storage', 'runtime', 'current.json'), 'utf8'));
      assert.equal(pointer.version, '1.6.1');
    });

    // No npm on PATH now: a second window must not need the network at all.
    const { RuntimeManager } = load();
    const second = new RuntimeManager(context(root), () => {});
    second.start();
    assert.equal(second.currentVersion(), '1.6.1');
    assert.ok(second.current());
    second.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a development runtime inside the extension wins over the managed one', posixOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'codebrain-manager-'));
  try {
    const ctx = context(root);
    const dev = join(ctx.extensionUri.fsPath, 'runtime', target);
    mkdirSync(join(dev, 'lib', 'dist', 'bin'), { recursive: true });
    writeFileSync(join(dev, 'node'), '');
    chmodSync(join(dev, 'node'), 0o755);
    writeFileSync(join(dev, 'lib', 'dist', 'bin', 'codegraph.js'), '');

    const { RuntimeManager } = load();
    const manager = new RuntimeManager(ctx, () => {});
    manager.start();
    assert.equal(manager.current().command, join(dev, 'node'));
    assert.equal(manager.currentVersion(), undefined);
    manager.dispose();
    assert.equal(existsSync(join(root, 'storage', 'runtime')), false, 'nothing was installed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a broken codebrain.runtime.path is reported, never silently replaced', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codebrain-manager-'));
  try {
    const { RuntimeManager, errors } = load({ path: join(root, 'nowhere') });
    const manager = new RuntimeManager(context(root), () => {});
    manager.start();
    await assert.rejects(manager.resolve(), /incomplete/);
    assert.equal(errors.length, 1);
    manager.dispose();
    assert.equal(existsSync(join(root, 'storage', 'runtime')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
