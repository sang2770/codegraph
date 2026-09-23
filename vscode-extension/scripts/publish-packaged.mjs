#!/usr/bin/env node
/**
 * Publish a `.vsix` that was built somewhere else — the CI half of
 * `publish-extension.mjs`: the package job builds and uploads an artifact, and
 * this verifies it and pushes it.
 *
 * The archive is read back before uploading: a package that accidentally
 * carries a development runtime, or is missing an entry point, installs
 * cleanly and then misbehaves — better caught here than by a user.
 *
 * Usage:
 *   node scripts/publish-packaged.mjs --dir <dir>              # verify only
 *   node scripts/publish-packaged.mjs --dir <dir> --publish    # verify + push
 *
 * Options:
 *   --dir <path>       Directory holding codebrain.vsix (required).
 *   --publish          Upload to the VS Code Marketplace. Needs VSCE_PAT.
 *   --pre-release      Publish as a pre-release (the package must have been
 *                      built with --pre-release too).
 *   --skip-duplicate   Succeed instead of failing when the version already
 *                      exists on the marketplace.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyPackage } from './verify-vsix.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDir, '..');

const USAGE =
  'usage: node scripts/publish-packaged.mjs --dir <dir> [--publish] [--pre-release] [--skip-duplicate]';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    publish: { type: 'boolean', default: false },
    'pre-release': { type: 'boolean', default: false },
    'skip-duplicate': { type: 'boolean', default: false },
  },
});

if (!values.dir) {
  console.error(`[publish] --dir is required.\n${USAGE}`);
  process.exit(1);
}

const packageDirectory = resolve(values.dir);

const manifest = JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf8'));
const extensionId = `${manifest.publisher}.${manifest.name}`;

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: extensionRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${String(result.status)}`);
  }
}

/**
 * The workspace copy of vsce, invoked as `node <entry>`.
 *
 * `node_modules/.bin/vsce` is a shim that Node refuses to spawn without a
 * shell on Windows; going straight to the entry point works everywhere.
 */
function resolveVsce() {
  const local = join(extensionRoot, 'node_modules', '@vscode', 'vsce', 'vsce');
  if (!existsSync(local)) {
    throw new Error('vsce is not installed. Run `npm ci` in vscode-extension/ first.');
  }
  return local;
}

function megabytes(path) {
  return `${(statSync(path).size / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  console.log(`[publish] ${extensionId} v${manifest.version}`);
  console.log(`[publish] package in ${packageDirectory}`);

  const vsix = join(packageDirectory, 'codebrain.vsix');
  if (!existsSync(vsix)) {
    throw new Error(`Missing ${vsix}. The package job did not produce an artifact.`);
  }
  await verifyPackage(vsix);
  console.log(`[publish] ok (${megabytes(vsix)})`);

  if (!values.publish) {
    console.log('\n[publish] verified the package; nothing was uploaded.');
    return;
  }

  if (!process.env.VSCE_PAT) {
    throw new Error(
      'VSCE_PAT is not set. Add the marketplace personal access token as a repository secret.',
    );
  }

  run(process.execPath, [
    resolveVsce(),
    'publish',
    '-i',
    vsix,
    ...(values['pre-release'] ? ['--pre-release'] : []),
    ...(values['skip-duplicate'] ? ['--skip-duplicate'] : []),
  ]);

  console.log(`\n[publish] published ${extensionId} v${manifest.version}`);
  console.log(
    `[publish] https://marketplace.visualstudio.com/items?itemName=${extensionId}`,
  );
}

main().catch((error) => {
  console.error(`[publish] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
