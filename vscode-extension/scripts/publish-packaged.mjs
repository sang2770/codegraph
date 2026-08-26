#!/usr/bin/env node
/**
 * Publish `.vsix` files that were built somewhere else.
 *
 * This is the CI half of `publish-extension.mjs`. That script packages and
 * publishes on one machine, which is right for a maintainer's laptop and
 * impossible in CI: each platform's runtime can only be built on its own
 * runner, so the six packages arrive as six separate artifacts and the thing
 * left to do is upload the set.
 *
 * Two properties are carried over from `publish-extension.mjs` deliberately:
 *
 *  - **One `vsce publish` for every target.** Publishing them one at a time
 *    leaves a half-published version on the marketplace if the fourth upload
 *    fails — some users then get a platform package that does not exist.
 *  - **Read the archive back before uploading it.** A `.vsix` carrying the
 *    wrong platform's runtime, or a `node` with no execute bit, installs
 *    cleanly and then fails on every command. Better caught here than by a
 *    user.
 *
 * Usage:
 *   node scripts/publish-packaged.mjs --dir <dir>              # verify only
 *   node scripts/publish-packaged.mjs --dir <dir> --publish    # verify + push
 *
 * Options:
 *   --dir <path>       Directory holding codebrain-<target>.vsix (required).
 *   --targets <list>   Comma-separated targets (default: every supported one).
 *   --publish          Upload to the VS Code Marketplace. Needs VSCE_PAT.
 *   --pre-release      Publish as a pre-release (the packages must have been
 *                      built with --pre-release too).
 *   --skip-duplicate   Succeed instead of failing when the version already
 *                      exists on the marketplace.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertTarget, SUPPORTED_TARGETS } from './runtime-target.mjs';
import { verifyPackage } from './verify-vsix.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDir, '..');

const USAGE =
  'usage: node scripts/publish-packaged.mjs --dir <dir> [--targets a,b] ' +
  '[--publish] [--pre-release] [--skip-duplicate]';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    targets: { type: 'string' },
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
const targets = (values.targets ? values.targets.split(',') : SUPPORTED_TARGETS)
  .map((target) => target.trim())
  .filter(Boolean)
  .map(assertTarget);

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
  console.log(`[publish] packages in ${packageDirectory}`);

  // Every package is located and verified before anything is uploaded: a
  // missing artifact must not surface halfway through a publish.
  const packages = [];
  for (const target of targets) {
    const vsix = join(packageDirectory, `codebrain-${target}.vsix`);
    if (!existsSync(vsix)) {
      throw new Error(
        `Missing ${vsix}. The ${target} package job did not produce an artifact — ` +
          'publish the whole set or narrow --targets deliberately.',
      );
    }
    await verifyPackage(vsix, target);
    console.log(`[publish] ${target}: ok (${megabytes(vsix)})`);
    packages.push(vsix);
  }

  if (!values.publish) {
    console.log(`\n[publish] verified ${packages.length} package(s); nothing was uploaded.`);
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
    ...packages.flatMap((path) => ['-i', path]),
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
