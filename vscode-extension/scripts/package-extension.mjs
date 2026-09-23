/**
 * Package the extension as ONE universal `.vsix`.
 *
 * The CodeGraph runtime is no longer inside the package: the extension
 * installs `@xuansang2770/codegraph` from npm on first activation and keeps it
 * updated (`src/runtimeInstaller.ts`), so a single platform-neutral package
 * serves every OS and architecture.
 *
 * A development runtime staged under `runtime/` (`npm run build:runtime`) is
 * excluded by `.vscodeignore`, and `verify-vsix.mjs` fails the build if one
 * slips in anyway.
 *
 * Usage:
 *   node scripts/package-extension.mjs [--pre-release] [--out <file>]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackage } from './verify-vsix.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDir, '..');
const { version } = JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf8'));
// A pre-release is stamped into the archive at package time — it cannot be
// decided later at publish time, so the flag has to travel this far.
const preRelease = process.argv.includes('--pre-release');
const outIndex = process.argv.indexOf('--out');
const out = resolve(extensionRoot, outIndex >= 0 ? process.argv[outIndex + 1] : `codebrain-${version}.vsix`);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: extensionRoot,
    stdio: 'inherit',
    env: process.env,
    // npm.cmd is a Windows command shim. Node 24 rejects direct spawnSync()
    // calls for .cmd files with EINVAL unless shell execution is enabled.
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${String(result.status)}`);
}

run(npmCommand, ['run', 'build']);
// `node <vsce entry>` rather than the `.bin` shim, which Windows refuses to
// spawn without a shell.
run(process.execPath, [
  join(extensionRoot, 'node_modules', '@vscode', 'vsce', 'vsce'),
  'package',
  '--out',
  out,
  ...(preRelease ? ['--pre-release'] : []),
]);
await verifyPackage(out);
console.log(`[package] ${out}`);
