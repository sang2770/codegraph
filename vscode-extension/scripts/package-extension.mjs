import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  assertTarget,
  normalizeTarget,
  SUPPORTED_TARGETS,
} from './runtime-target.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDir, '..');
const runtimeRoot = join(extensionRoot, 'runtime');
const packageAll = process.argv.includes('--all');
const targetFlagIndex = process.argv.indexOf('--target');
const explicitTarget =
  targetFlagIndex >= 0 ? process.argv[targetFlagIndex + 1] : undefined;
const targets = packageAll
  ? SUPPORTED_TARGETS
  : [assertTarget(explicitTarget ?? normalizeTarget())];
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: extensionRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${String(result.status)}`);
  }
}

for (const target of targets) {
  if (existsSync(runtimeRoot)) {
    for (const otherTarget of SUPPORTED_TARGETS) {
      if (otherTarget !== target) {
        rmSync(join(runtimeRoot, otherTarget), { recursive: true, force: true });
      }
    }
  }

  run(process.execPath, ['./scripts/build-runtime.mjs', target]);
  run(npmCommand, ['run', 'build']);
  run(npxCommand, [
    'vsce',
    'package',
    '--target',
    target,
    '--out',
    `codegraph-${target}.vsix`,
  ]);
}
