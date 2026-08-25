import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
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
    // npm.cmd and npx.cmd are Windows command shims. Node 24 rejects direct
    // spawnSync() calls for .cmd files with EINVAL unless shell execution is
    // enabled.
    shell: process.platform === 'win32',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${String(result.status)}`);
  }
}

// Keep the backup on the same volume as the extension. Windows cannot rename
// a directory across volumes (for example, from D: to the user's C: temp).
const runtimeBackupRoot = mkdtempSync(
  join(extensionRoot, '.runtime-package-'),
);

function hideOtherRuntimes(target) {
  const hiddenTargets = [];
  if (existsSync(runtimeRoot)) {
    for (const otherTarget of SUPPORTED_TARGETS) {
      if (otherTarget !== target) {
        const runtimePath = join(runtimeRoot, otherTarget);
        if (existsSync(runtimePath)) {
          const backupPath = join(runtimeBackupRoot, otherTarget);
          mkdirSync(runtimeBackupRoot, { recursive: true });
          renameSync(runtimePath, backupPath);
          hiddenTargets.push({ runtimePath, backupPath });
        }
      }
    }
  }

  return () => {
    for (const { runtimePath, backupPath } of hiddenTargets) {
      renameSync(backupPath, runtimePath);
    }
  };
}

try {
  for (const target of targets) {
    const restoreRuntimes = hideOtherRuntimes(target);
    try {
      run(process.execPath, ['./scripts/build-runtime.mjs', target]);
      run(npmCommand, ['run', 'build']);
      run(npxCommand, [
        'vsce',
        'package',
        '--target',
        target,
        '--out',
        `codebrain-${target}.vsix`,
      ]);
    } finally {
      restoreRuntimes();
    }
  }
} finally {
  rmSync(runtimeBackupRoot, { recursive: true, force: true });
}
