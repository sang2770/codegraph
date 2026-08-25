import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Files a POSIX runtime bundle must ship with the execute bit set. */
export const POSIX_EXECUTABLES = ['node', join('bin', 'codegraph')];

export function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Force the execute bit on a staged runtime's launchers before `vsce package`
 * reads their modes into the archive. `tar` already preserves what the bundle
 * had, but the mode a Linux or macOS user ends up with is decided here — so set
 * it explicitly rather than inheriting whatever the packaging host produced.
 *
 * Windows cannot record a unix execute bit at all, so a POSIX target packaged
 * there ships without one. That is a warning, not a build failure: the
 * extension repairs the bit on first run (`ensureRuntimeExecutable` in
 * `src/runtime.ts`).
 *
 * @param {string} root Staged runtime directory, i.e. `runtime/<target>`.
 * @param {string} target The target being staged, for the warning text.
 * @returns {string[]} The files whose mode was set.
 */
export function markExecutable(root, target) {
  const files = POSIX_EXECUTABLES.map((relative) => join(root, relative)).filter(
    (file) => existsSync(file),
  );

  for (const file of files) {
    chmodSync(file, (statSync(file).mode & 0o777) | 0o755);
  }

  if (process.platform === 'win32') {
    console.warn(
      `[runtime] packaged on Windows: ${target} ships without a unix execute bit; ` +
        'the extension restores it on first run. Package POSIX targets from macOS or Linux to avoid that.',
    );
    return files;
  }

  const stillBlocked = files.filter((file) => !isExecutable(file));
  if (stillBlocked.length > 0) {
    throw new Error(
      `Staged runtime is not executable: ${stillBlocked.join(', ')}`,
    );
  }

  return files;
}
