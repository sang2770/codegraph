import test from 'node:test';
import assert from 'node:assert/strict';
import { promoteChangelog } from '../scripts/prepare-release.mjs';

const CHANGELOG = `# Changelog

All notable changes are documented here.

## [Unreleased]

### New Features

- A brand new thing.
- Another new thing.

### Fixes

- Stopped a crash.

## [1.2.0] - 2026-08-11

### New Features

- The previous release.
`;

test('the unreleased block becomes the version, and a fresh one opens above it', () => {
  const result = promoteChangelog(CHANGELOG, '2.0.0', { date: '2026-08-26' });

  assert.equal(result.changed, true);
  assert.equal(result.mode, 'promoted');
  assert.equal(result.entries, 3);
  assert.match(result.text, /## \[2\.0\.0\] - 2026-08-26/);
  // The empty Unreleased block stays on top, ready for the next entry.
  assert.match(result.text, /## \[Unreleased\]\n\n\n## \[2\.0\.0\]/);
  // Content moves across untouched, and the older release is not disturbed.
  assert.match(result.text, /## \[2\.0\.0\][^#]*### New Features\n\n- A brand new thing\./);
  assert.match(result.text, /## \[1\.2\.0\] - 2026-08-11/);
  assert.match(result.text, /^# Changelog\n\nAll notable changes/);
});

test('promoting twice is a no-op, so a re-run of a failed release is safe', () => {
  const once = promoteChangelog(CHANGELOG, '2.0.0', { date: '2026-08-26' });
  const twice = promoteChangelog(once.text, '2.0.0', { date: '2026-08-27' });

  assert.equal(twice.changed, false);
  assert.equal(twice.mode, 'noop');
  assert.match(twice.reason, /already promoted/);
  assert.equal(twice.text, once.text);
  // Not re-dated by the second run.
  assert.ok(!twice.text.includes('2026-08-27'));
});

test('a version block started early is merged into, not duplicated', () => {
  const started = `# Changelog

## [Unreleased]

### New Features

- Late arrival.

### Breaking Changes

- A section the version block does not have yet.

## [2.0.0] - 2026-08-20

### New Features

- Documented early.

### Fixes

- An early fix.
`;

  const result = promoteChangelog(started, '2.0.0', { date: '2026-08-26' });
  assert.equal(result.mode, 'merged');
  assert.equal(result.entries, 2);

  // One heading, both entries, original order kept.
  assert.equal(result.text.match(/### New Features/g).length, 1);
  assert.match(result.text, /- Documented early\.\n\n- Late arrival\./);
  // A sub-section with no counterpart is appended rather than dropped.
  assert.match(result.text, /### Breaking Changes\n\n- A section the version block/);
  // The date on the existing block is left alone, and Unreleased is emptied.
  assert.match(result.text, /## \[2\.0\.0\] - 2026-08-20/);
  assert.match(result.text, /## \[Unreleased\]\n\n\n## \[2\.0\.0\]/);
  assert.ok(!result.text.includes('- Late arrival.\n\n### Breaking'), 'Unreleased must be empty');
});

test('multi-word sub-headings pair up instead of duplicating', () => {
  // The root repo's promoter matches `### (\\w+)` only, which would treat
  // "New Features" as unmatched and append a second copy of the heading.
  const result = promoteChangelog(
    `# Changelog\n\n## [Unreleased]\n\n### New Features\n\n- b\n\n## [1.0.0] - 2026-01-01\n\n### New Features\n\n- a\n`,
    '1.0.0',
  );
  assert.equal(result.text.match(/### New Features/g).length, 1);
  assert.match(result.text, /- a\n\n- b/);
});

test('entries written straight under the heading survive a merge', () => {
  const result = promoteChangelog(
    `# Changelog\n\n## [Unreleased]\n\n- loose entry\n\n## [1.0.0] - 2026-01-01\n\n### Fixes\n\n- a\n`,
    '1.0.0',
  );
  assert.equal(result.mode, 'merged');
  assert.match(result.text, /- loose entry/);
  assert.match(result.text, /### Fixes\n\n- a/);
});

test('an empty or missing unreleased block reports why rather than writing', () => {
  const empty = promoteChangelog('# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n- a\n', '2.0.0');
  assert.equal(empty.changed, false);
  assert.match(empty.reason, /no entries/);

  const headingsOnly = promoteChangelog(
    '# Changelog\n\n## [Unreleased]\n\n### New Features\n\n## [1.0.0] - 2026-01-01\n\n- a\n',
    '2.0.0',
  );
  assert.equal(headingsOnly.changed, false, 'a bare sub-heading is not an entry');

  const none = promoteChangelog('# Changelog\n\n## [1.0.0] - 2026-01-01\n\n- a\n', '2.0.0');
  assert.equal(none.changed, false);
  assert.match(none.reason, /no \[Unreleased\] block/);
});
