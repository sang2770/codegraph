#!/usr/bin/env node
/**
 * Package the CodeBrain extension and, with `--publish`, push it to the VS Code
 * Marketplace using the locally installed (and already logged-in) `vsce`.
 *
 * One universal `.vsix`: the CodeGraph runtime is installed from npm by the
 * extension itself, so there is no per-platform runtime to build or stage.
 *
 * Usage:
 *   node scripts/publish-extension.mjs              # package only
 *   node scripts/publish-extension.mjs --publish    # package + push
 *
 * Options:
 *   --publish          Push the packaged .vsix to the marketplace.
 *   --pre-release      Mark the package as pre-release.
 *   --skip-duplicate   Do not fail when the version is already published.
 *   --skip-build       Skip `npm run build` (use the current dist/ as-is).
 *   --yes              Do not ask for confirmation before publishing.
 */
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyPackage } from './verify-vsix.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDir, '..');
const USAGE =
  'usage: node scripts/publish-extension.mjs [--publish] ' +
  '[--pre-release] [--skip-duplicate] [--skip-build] [--yes]';

function parseOptions() {
  try {
    return parseArgs({
      options: {
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
  console.log(`[publish] vsce: ${vsce.label}`);

  if (values['skip-build']) {
    console.log('[publish] --skip-build: using the existing dist/');
  } else {
    console.log('[publish] building extension bundles');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    run(npm, ['run', 'build'], { shell: process.platform === 'win32' });
  }

  const vsix = join(extensionRoot, `codebrain-${version}.vsix`);
  rmSync(vsix, { force: true });
  console.log('[publish] packaging');
  vsceRun(vsce, ['package', '--out', vsix, ...(values['pre-release'] ? ['--pre-release'] : [])]);
  await verifyPackage(vsix);
  console.log(`[publish] ${vsix} (${megabytes(vsix)})`);

  if (!values.publish) {
    console.log('\n[publish] packaged only — nothing was uploaded.');
    console.log('[publish] re-run with --publish to push, or upload by hand:');
    console.log(`  ${[vsce.command, ...vsce.prefix].map((part) => `"${part}"`).join(' ')} publish -i "${vsix}"`);
    return;
  }

  const approved = await confirm(`\nPublish ${extensionId} v${version} to the VS Code Marketplace?`);
  if (!approved) {
    console.log('[publish] aborted — the package is still on disk.');
    return;
  }

  vsceRun(vsce, [
    'publish',
    '-i',
    vsix,
    ...(values['pre-release'] ? ['--pre-release'] : []),
    ...(values['skip-duplicate'] ? ['--skip-duplicate'] : []),
  ]);

  console.log(`\n[publish] published ${extensionId} v${version}: ${vsix}`);
  console.log(`[publish] https://marketplace.visualstudio.com/items?itemName=${extensionId}`);
}

// Only `main()` is guarded — this module parses argv at import time, so it is
// not importable. The reusable half lives in `verify-vsix.mjs`.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[publish] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
