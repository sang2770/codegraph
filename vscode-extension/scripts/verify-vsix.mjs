/**
 * Read a packaged `.vsix` back and assert it is what we think it is.
 *
 * The failures this catches all look identical to a user: the extension
 * installs cleanly from the marketplace and then fails on every single
 * command. Either the archive carries the wrong platform's runtime (so there
 * is no launcher for the machine it landed on), or it carries the right one
 * with no execute bit (so the launcher cannot run). Both are cheap to detect
 * here and expensive to discover after a release.
 *
 * Its own module, with no argument parsing or other top-level work, so both
 * `publish-extension.mjs` (package + publish on one machine) and
 * `publish-packaged.mjs` (publish artifacts built by CI) can import it.
 */
import { SUPPORTED_TARGETS } from './runtime-target.mjs';

/**
 * @param {string} vsix Path to the package.
 * @param {string} target The platform target it was built for.
 * @throws when the archive contradicts the target it claims to be for.
 */
export async function verifyPackage(vsix, target) {
  let yauzl;
  try {
    yauzl = (await import('yauzl')).default ?? (await import('yauzl'));
  } catch {
    // yauzl reaches us through vsce rather than as a direct dependency, so a
    // missing copy is a reason to skip the check, not to fail a release.
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
  const strays = SUPPORTED_TARGETS.filter((other) => other !== target).filter((other) =>
    entries.some((entry) => entry.fileName.startsWith(`extension/runtime/${other}/`)),
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
