#!/usr/bin/env node
/**
 * Package the CodeBrain extension for its Linux and Windows marketplace
 * targets and, with `--publish`, push them to the VS Code Marketplace using the
 * locally installed (and already logged-in) `vsce`.
 *
 * The runtime is deliberately NOT built here — `runtime/<target>/` is staged by
 * hand with `scripts/build-runtime.mjs`, which takes many minutes per target
 * and needs a toolchain this script has no business assuming. What this script
 * does instead is refuse to ship a target whose runtime is missing or broken: a
 * `.vsix` without a working runtime installs cleanly and then fails on every
 * single command, which is the worst possible thing to have on a store.
 *
 * Usage:
 *   node scripts/publish-extension.mjs                          # package only
 *   node scripts/publish-extension.mjs --publish                # package + push
 *   node scripts/publish-extension.mjs --targets linux-x64,linux-arm64 --publish
 *
 * Options:
 *   --targets <list>   Comma-separated targets (default: linux-x64,win32-x64).
 *   --publish          Push the packaged .vsix files to the marketplace.
 *   --pre-release      Mark the packages as pre-release.
 *   --skip-duplicate   Do not fail when the version is already published.
 *   --skip-build       Skip `npm run build` (use the current dist/ as-is).
 *   --yes              Do not ask for confirmation before publishing.
 */
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isExecutable, markExecutable } from './runtime-permissions.mjs';
import { assertTarget, SUPPORTED_TARGETS } from './runtime-target.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDir, '..');
const DEFAULT_TARGETS = ['linux-x64', 'win32-x64'];

const USAGE =
  'usage: node scripts/publish-extension.mjs [--targets a,b] [--publish] ' +
  '[--pre-release] [--skip-duplicate] [--skip-build] [--yes]';

function parseOptions() {
  try {
    return parseArgs({
      options: {
        targets: { type: 'string' },
        publish: { type: 'boolean', default: false },
        'pre-release': { type: 'boolean', default: false },
        'skip-duplicate': { type: 'boolean', default: false },
        'skip-build': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
      },
    }).values;
  } catch (error) {
    console.error(`[publish] ${error.message}\n${USAGE}`);
    process.exit(1);
  }
}

const values = parseOptions();

let targets;
try {
  targets = (values.targets ? values.targets.split(',') : DEFAULT_TARGETS)
    .map((target) => target.trim())
    .filter(Boolean)
    .map((target) => assertTarget(target));
} catch (error) {
  console.error(`[publish] ${error.message}\n${USAGE}`);
  process.exit(1);
}

const manifest = JSON.parse(
  readFileSync(join(extensionRoot, 'package.json'), 'utf8'),
);
const { version } = manifest;
const extensionId = `${manifest.publisher}.${manifest.name}`;

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: extensionRoot,
    stdio: 'inherit',
    env: process.env,
    ...options,
  });
}

/**
 * Prefer the workspace's own `vsce` — that is the one pinned by
 * package-lock.json. A globally installed one is an acceptable fallback:
 * `vsce login` writes its credential to a shared store, so either binary is
 * already authenticated.
 *
 * The local copy is invoked as `node <entry>` rather than through
 * `node_modules/.bin`, because on Windows that shim is a `.cmd` file, which
 * Node refuses to spawn without a shell (the CVE-2024-27980 hardening) and
 * which then mangles arguments containing spaces.
 */
function resolveVsce() {
  const local = join(extensionRoot, 'node_modules', '@vscode', 'vsce', 'vsce');
  const useGlobal = process.env.CODEBRAIN_USE_GLOBAL_VSCE === '1';
  if (!useGlobal && existsSync(local)) {
    return { command: process.execPath, prefix: [local], label: local };
  }

  const global = process.platform === 'win32' ? 'vsce.cmd' : 'vsce';
  const shell = process.platform === 'win32';
  try {
    execFileSync(global, ['--version'], { stdio: 'ignore', shell });
    return { command: global, prefix: [], label: `${global} (global)`, shell };
  } catch {
    throw new Error(
      'vsce was not found. Install it in this workspace (npm ci) or globally (npm i -g @vscode/vsce).',
    );
  }
}

/** Run vsce with the given arguments. */
function vsceRun(vsce, args) {
  run(vsce.command, [...vsce.prefix, ...args], { shell: vsce.shell ?? false });
}

/**
 * Check a hand-staged runtime the way the extension will use it at runtime, and
 * report what a user of this `.vsix` would hit. Missing files are fatal; a
 * missing native kernel is not — the runtime falls back to WASM extraction,
 * which is slower but correct.
 */
function inspectRuntime(target) {
  const root = join(extensionRoot, 'runtime', target);
  const windows = target.startsWith('win32-');
  const launcher = join(root, windows ? 'node.exe' : 'node');
  const entrypoint = join(root, 'lib', 'dist', 'bin', 'codegraph.js');

  const missing = [launcher, entrypoint].filter((file) => !existsSync(file));
  if (!existsSync(root)) {
    throw new Error(
      `No runtime staged for ${target}. Build it first:\n` +
        `  node ./scripts/build-runtime.mjs ${target}`,
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `The runtime staged for ${target} is incomplete (missing ${missing.join(', ')}).\n` +
        `  Rebuild it: node ./scripts/build-runtime.mjs ${target}`,
    );
  }

  // The bug this guards against: a marketplace package whose `node` carries no
  // execute bit. The extension repairs that on first run, but only if it can
  // write to its own install directory — far better to ship it correct.
  if (!windows) markExecutable(root, target);

  return {
    root,
    launcher,
    nativeKernel: existsSync(join(root, 'lib', 'kernel', 'codegraph-kernel.node')),
  };
}

/**
 * A `.vscodeignore` that excludes every runtime except this target's, written
 * to a temp file and handed to `vsce --ignoreFile`.
 *
 * The alternative — deleting the other targets' `runtime/` folders, the way
 * `package-extension.mjs` does — would throw away runtimes that were built by
 * hand over many minutes. Nothing in the working tree is touched here.
 */
function writeIgnoreFile(target, directory) {
  const base = existsSync(join(extensionRoot, '.vscodeignore'))
    ? readFileSync(join(extensionRoot, '.vscodeignore'), 'utf8').trimEnd()
    : '';
  const exclusions = SUPPORTED_TARGETS.filter((other) => other !== target).map(
    (other) => `runtime/${other}/**`,
  );
  const path = join(directory, `vscodeignore-${target}`);
  writeFileSync(
    path,
    `${base}\n\n# generated by publish-extension.mjs for ${target}\n${exclusions.join('\n')}\n`,
  );
  return path;
}

/**
 * Read back the archive that is about to be published and assert it is what we
 * think it is: this target's runtime present and executable, no other target's
 * runtime along for the ride. Best-effort — `yauzl` reaches us through vsce, so
 * skip the check rather than fail the release if it is not installed.
 */
export async function verifyPackage(vsix, target) {
  let yauzl;
  try {
    yauzl = (await import('yauzl')).default ?? (await import('yauzl'));
  } catch {
    console.warn('[publish] yauzl unavailable — skipped .vsix verification');
    return;
  }

  const entries = await new Promise((fulfil, fail) => {
    yauzl.open(vsix, { lazyEntries: true }, (error, zip) => {
      if (error) return fail(error);
      const found = [];
      zip.on('entry', (entry) => {
        found.push(entry);
        zip.readEntry();
      });
      zip.on('end', () => fulfil(found));
      zip.on('error', fail);
      zip.readEntry();
    });
  });

  const prefix = `extension/runtime/${target}/`;
  const strays = SUPPORTED_TARGETS.filter((other) => other !== target).filter(
    (other) =>
      entries.some((entry) =>
        entry.fileName.startsWith(`extension/runtime/${other}/`),
      ),
  );
  if (strays.length > 0) {
    throw new Error(
      `${vsix} also contains runtimes for ${strays.join(', ')} — the ignore file did not apply.`,
    );
  }

  const launcher = entries.find(
    (entry) =>
      entry.fileName === `${prefix}${target.startsWith('win32-') ? 'node.exe' : 'node'}`,
  );
  if (!launcher) {
    throw new Error(`${vsix} does not contain the ${target} runtime launcher.`);
  }

  if (!target.startsWith('win32-') && process.platform !== 'win32') {
    // The mode a Linux user's install starts from, read from the archive
    // itself rather than from the staging directory we set it in.
    const mode = (launcher.externalFileAttributes >>> 16) & 0o7777;
    if ((mode & 0o111) === 0) {
      throw new Error(
        `${vsix} records ${prefix}node as non-executable (mode ${mode.toString(8).padStart(4, '0')}). ` +
          'Package this target from macOS or Linux.',
      );
    }
  } else if (!target.startsWith('win32-')) {
    console.warn(
      `[publish] ${vsix} was packaged on Windows; POSIX execute-bit verification skipped. ` +
        'The extension will restore it on first run.',
    );
  }
}

async function confirm(question) {
  if (values.yes) return true;
  if (!process.stdin.isTTY) {
    throw new Error(
      'Refusing to publish without a terminal to confirm at. Re-run with --yes if this is intentional.',
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const megabytes = (path) => `${(statSync(path).size / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const vsce = resolveVsce();

  console.log(`[publish] ${extensionId} v${version}`);
  console.log(`[publish] targets: ${targets.join(', ')}`);
  console.log(`[publish] vsce: ${vsce.label}`);

  // Everything that can reject the release is checked before anything is built
  // or uploaded, so a missing runtime costs seconds rather than a full package
  // run per target.
  const runtimes = new Map(targets.map((target) => [target, inspectRuntime(target)]));
  for (const [target, runtime] of runtimes) {
    console.log(
      `[publish] ${target}: runtime ok${runtime.nativeKernel ? ', native kernel' : ', WASM fallback (no native kernel)'}`,
    );
  }

  if (values['skip-build']) {
    console.log('[publish] --skip-build: using the existing dist/');
  } else {
    console.log('[publish] building extension bundles');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    run(npm, ['run', 'build'], { shell: process.platform === 'win32' });
  }

  const staging = mkdtempSync(join(tmpdir(), 'codebrain-publish-'));
  const packages = [];
  try {
    for (const target of targets) {
      const vsix = join(extensionRoot, `codebrain-${target}-${version}.vsix`);
      rmSync(vsix, { force: true });
      console.log(`[publish] packaging ${target}`);
      vsceRun(vsce, [
        'package',
        '--target',
        target,
        '--out',
        vsix,
        '--ignoreFile',
        writeIgnoreFile(target, staging),
        ...(values['pre-release'] ? ['--pre-release'] : []),
      ]);
      await verifyPackage(vsix, target);
      packages.push(vsix);
      console.log(`[publish] ${target}: ${vsix} (${megabytes(vsix)})`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  if (!values.publish) {
    console.log('\n[publish] packaged only — nothing was uploaded.');
    console.log('[publish] re-run with --publish to push, or upload by hand:');
    console.log(
      `  ${[vsce.command, ...vsce.prefix].map((part) => `"${part}"`).join(' ')} publish ` +
        packages.map((path) => `-i "${path}"`).join(' '),
    );
    return;
  }

  const approved = await confirm(
    `\nPublish ${extensionId} v${version} (${targets.join(', ')}) to the VS Code Marketplace?`,
  );
  if (!approved) {
    console.log('[publish] aborted — the packages are still on disk.');
    return;
  }

  // One invocation for every target: the marketplace then sees a single
  // version with all its platform packages, instead of a half-published
  // version if a later upload fails.
  vsceRun(vsce, [
    'publish',
    ...packages.flatMap((path) => ['-i', path]),
    ...(values['pre-release'] ? ['--pre-release'] : []),
    ...(values['skip-duplicate'] ? ['--skip-duplicate'] : []),
  ]);

  console.log(`\n[publish] published ${extensionId} v${version}:`);
  for (const path of packages) console.log(`  ${path}`);
  console.log(
    `[publish] https://marketplace.visualstudio.com/items?itemName=${extensionId}`,
  );
}

// Importable without side effects, so `verifyPackage` can be exercised against
// a .vsix on its own.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[publish] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
