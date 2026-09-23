/**
 * Read a packaged `.vsix` back and assert it is what we think it is.
 *
 * The package is universal and must stay small: the CodeGraph runtime is
 * installed from npm at first activation, so a `runtime/` directory inside the
 * archive means a development runtime leaked into a release (hundreds of MB,
 * and for one platform only). The entry points the extension cannot start
 * without are checked too.
 *
 * Its own module, with no argument parsing or other top-level work, so the
 * package and publish scripts can all import it.
 */

const REQUIRED = [
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/dist/atlassian-server.js',
  'extension/skills/codebrain/SKILL.md',
];

/**
 * @param {string} vsix Path to the package.
 * @throws when the archive carries a runtime or misses a required file.
 */
export async function verifyPackage(vsix) {
  let yauzl;
  try {
    yauzl = (await import('yauzl')).default ?? (await import('yauzl'));
  } catch {
    // yauzl reaches us through vsce rather than as a direct dependency, so a
    // missing copy is a reason to skip the check, not to fail a release.
    console.warn('[package] yauzl unavailable — skipped .vsix verification');
    return;
  }

  const entries = await new Promise((fulfil, fail) => {
    yauzl.open(vsix, { lazyEntries: true }, (error, zip) => {
      if (error) return fail(error);
      const found = [];
      zip.on('entry', (entry) => {
        found.push(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => fulfil(found));
      zip.on('error', fail);
      zip.readEntry();
    });
  });

  const runtime = entries.filter((name) => name.startsWith('extension/runtime/'));
  if (runtime.length > 0) {
    throw new Error(
      `${vsix} contains a bundled runtime (${runtime.length} files under extension/runtime/). ` +
        'The runtime is installed from npm at activation — check .vscodeignore.',
    );
  }

  const missing = REQUIRED.filter((name) => !entries.includes(name));
  if (missing.length > 0) {
    throw new Error(`${vsix} is missing ${missing.join(', ')}.`);
  }
}
