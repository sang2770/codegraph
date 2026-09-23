import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTypeScript } from './helpers/load.mjs';

const {
  compareVersions,
  installRuntime,
  isExactVersion,
  missingRuntimeFiles,
  normalizeRegistry,
  platformPackage,
  pruneRuntimes,
  readCurrent,
  resolveVersion,
  runtimeDirFor,
  runtimeTarget,
  writeCurrent,
} = loadTypeScript('runtimeInstaller.ts');

const posixOnly = { skip: process.platform === 'win32' };

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'codebrain-installer-'));
}

/** Lay down the files a platform package holds. */
function stageRuntime(dir) {
  mkdirSync(join(dir, 'lib', 'dist', 'bin'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, process.platform === 'win32' ? 'node.exe' : 'node'), '');
  writeFileSync(join(dir, 'lib', 'dist', 'bin', 'codegraph.js'), '');
}

test('targets and package names follow the npm platform packages', () => {
  assert.equal(runtimeTarget('linux', 'x64'), 'linux-x64');
  assert.equal(runtimeTarget('win32', 'arm64'), 'win32-arm64');
  assert.throws(() => runtimeTarget('freebsd', 'x64'), /no CodeGraph runtime/);
  assert.throws(() => runtimeTarget('linux', 'ia32'), /no CodeGraph runtime/);
  assert.equal(platformPackage('darwin-arm64'), '@xuansang2770/codegraph-darwin-arm64');
});

test('versions order like semver, pre-releases below their release', () => {
  assert.equal(compareVersions('1.6.1', '1.6.0'), 1);
  assert.equal(compareVersions('1.6.1', '1.10.0'), -1);
  assert.equal(compareVersions('v2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('1.7.0-beta.2', '1.7.0'), -1);
  assert.equal(compareVersions('1.7.0-beta.10', '1.7.0-beta.2'), 1);
  assert.equal(isExactVersion('1.6.1'), true);
  assert.equal(isExactVersion('latest'), false);
  assert.equal(isExactVersion('^1.6.0'), false);
});

test('a registry setting is normalised, and junk is ignored', () => {
  assert.equal(normalizeRegistry('https://npm.corp.example/repo'), 'https://npm.corp.example/repo/');
  assert.equal(normalizeRegistry(' https://registry.npmjs.org/ '), 'https://registry.npmjs.org/');
  assert.equal(normalizeRegistry(''), undefined);
  assert.equal(normalizeRegistry('npm.corp.example'), undefined);
});

test('the pointer is only trusted while the runtime it names is intact', () => {
  const root = sandbox();
  try {
    const dir = runtimeDirFor(root, '1.6.1', 'linux-x64');
    assert.equal(readCurrent(root), undefined);

    writeCurrent(root, { version: '1.6.1', dir });
    // The directory is not there yet: a pointer to nothing is no runtime.
    assert.equal(readCurrent(root), undefined);

    stageRuntime(dir);
    assert.deepEqual(readCurrent(root), { version: '1.6.1', dir });
    assert.deepEqual(missingRuntimeFiles(dir), []);

    writeFileSync(join(root, 'current.json'), '{ not json');
    assert.equal(readCurrent(root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pruning keeps the named versions, fresh installs in progress, and foreign files', () => {
  const root = sandbox();
  try {
    for (const version of ['1.5.0', '1.6.0', '1.6.1']) mkdirSync(join(root, version));
    mkdirSync(join(root, '.tmp-1.7.0-1-aaaa'));
    mkdirSync(join(root, '.tmp-1.4.0-2-bbbb'));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(join(root, '.tmp-1.4.0-2-bbbb'), old, old);
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'current.json'), '{}');

    pruneRuntimes(root, ['1.6.1', '1.6.0']);

    assert.equal(existsSync(join(root, '1.5.0')), false);
    assert.equal(existsSync(join(root, '1.6.0')), true);
    assert.equal(existsSync(join(root, '1.6.1')), true);
    // Another window may still be writing this one.
    assert.equal(existsSync(join(root, '.tmp-1.7.0-1-aaaa')), true);
    assert.equal(existsSync(join(root, '.tmp-1.4.0-2-bbbb')), false);
    assert.equal(existsSync(join(root, 'notes')), true);
    assert.equal(existsSync(join(root, 'current.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A stand-in `npm` on disk: records its arguments, answers `view` with a
 * version, and on `install` lays down the platform package under `--prefix`,
 * the way npm resolves the optional dependency.
 */
function fakeNpm(root, { skipPlatform = false } = {}) {
  const script = join(root, 'npm');
  const log = join(root, 'npm.log');
  const target = runtimeTarget();
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'view') { process.stdout.write('"1.6.1"'); process.exit(0); }
if (args[0] === 'install') {
  if (${skipPlatform}) process.exit(0);
  const prefix = args[args.indexOf('--prefix') + 1];
  const dir = path.join(prefix, 'node_modules', '@xuansang2770', 'codegraph-${target}');
  fs.mkdirSync(path.join(dir, 'lib', 'dist', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node'), '');
  fs.writeFileSync(path.join(dir, 'lib', 'dist', 'bin', 'codegraph.js'), '');
  process.exit(0);
}
process.exit(1);
`,
  );
  chmodSync(script, 0o755);
  return { script, calls: () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) };
}

test('resolving a version asks npm, which knows the registry auth', posixOnly, async () => {
  const root = sandbox();
  try {
    const npm = fakeNpm(root);
    const version = await resolveVersion('latest', {
      npm: npm.script,
      registry: 'http://127.0.0.1:9/',
      log: () => {},
    });
    assert.equal(version, '1.6.1');
    assert.deepEqual(npm.calls()[0], ['view', '@xuansang2770/codegraph@latest', 'version', '--json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('npm installs into a versioned directory, and a second install is a no-op', posixOnly, async () => {
  const root = sandbox();
  try {
    const npm = fakeNpm(root);
    const storageRoot = join(root, 'storage');
    const options = { storageRoot, version: '1.6.1', npm: npm.script, registry: 'http://127.0.0.1:9/', log: () => {} };

    const installed = await installRuntime(options);
    assert.equal(installed.version, '1.6.1');
    assert.equal(installed.dir, runtimeDirFor(storageRoot, '1.6.1', runtimeTarget()));
    assert.deepEqual(missingRuntimeFiles(installed.dir), []);

    const install = npm.calls().find((args) => args[0] === 'install');
    assert.ok(install.includes('@xuansang2770/codegraph@1.6.1'));
    assert.ok(install.includes('--no-save'));

    // Nothing left behind but the version directory itself.
    const leftovers = (await import('node:fs')).readdirSync(storageRoot);
    assert.deepEqual(leftovers, ['1.6.1']);

    await installRuntime(options);
    assert.equal(npm.calls().filter((args) => args[0] === 'install').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a registry that drops the platform package falls back, and fails loudly offline', posixOnly, async () => {
  const root = sandbox();
  try {
    const npm = fakeNpm(root, { skipPlatform: true });
    const storageRoot = join(root, 'storage');
    const messages = [];
    await assert.rejects(
      installRuntime({
        storageRoot,
        version: '1.6.1',
        npm: npm.script,
        // Nothing listens on the discard port, so the direct download fails.
        registry: 'http://127.0.0.1:9/',
        log: (message) => messages.push(message),
      }),
    );
    assert.ok(messages.some((message) => /downloading it directly/.test(message)));
    // A failed install leaves neither a version directory nor temp files.
    assert.deepEqual((await import('node:fs')).readdirSync(storageRoot), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
