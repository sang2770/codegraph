import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const { headingMatchesVersion, renderReleaseNotes, sectionsSince, splitSections } =
  loadTypeScript('releaseNotes.ts');

const CHANGELOG = `# Changelog

All notable changes are documented here.

## [Unreleased]

### New Features

- Something still cooking.

## [2.0.0] - 2026-08-20

### New Features

- Jira and Confluence tools.

### Fixes

- A crash on startup.

## [1.2.0] - 2026-08-11

- Commit message generation.

## [1.1.0] - 2026-08-01

- The very first thing.
`;

test('sections split on ## only, and the preamble is dropped', () => {
  const sections = splitSections(CHANGELOG);
  assert.deepEqual(
    sections.map((section) => section.heading),
    ['[Unreleased]', '[2.0.0] - 2026-08-20', '[1.2.0] - 2026-08-11', '[1.1.0] - 2026-08-01'],
  );
  // `###` belongs to its section rather than starting a new one.
  assert.match(sections[1].body, /### New Features/);
  assert.match(sections[1].body, /### Fixes/);
  assert.ok(!sections[0].body.includes('All notable changes'));
});

test('a version is matched in both bracketed and bare headings', () => {
  assert.ok(headingMatchesVersion('[2.0.0] - 2026-08-20', '2.0.0'));
  assert.ok(headingMatchesVersion('2.0.0', '2.0.0'));
  assert.ok(headingMatchesVersion('v2.0.0 (2026-08-20)', '2.0.0'));
  // A prefix must not match: 2.0.0 is not 2.0.0-beta, nor 12.0.0.
  assert.ok(!headingMatchesVersion('[2.0.0-beta] - x', '2.0.0'));
  assert.ok(!headingMatchesVersion('[12.0.0] - x', '2.0.0'));
  assert.ok(!headingMatchesVersion('[2.0.0] - x', ''));
});

test('a user who skipped releases gets every section since theirs', () => {
  const sections = splitSections(CHANGELOG);
  assert.deepEqual(
    sectionsSince(sections, '1.1.0').map((section) => section.heading),
    ['[Unreleased]', '[2.0.0] - 2026-08-20', '[1.2.0] - 2026-08-11'],
  );
  assert.deepEqual(
    sectionsSince(sections, '1.2.0').map((section) => section.heading),
    ['[Unreleased]', '[2.0.0] - 2026-08-20'],
  );
});

test('an unknown or newest previous version shows only the top section', () => {
  const sections = splitSections(CHANGELOG);
  // A version the changelog no longer mentions must not dump the whole history.
  assert.equal(sectionsSince(sections, '0.0.1').length, 1);
  assert.equal(sectionsSince(sections, undefined).length, 1);
  // The previous version being the top section leaves nothing newer to show.
  assert.deepEqual(
    sectionsSince(sections, 'Unreleased').map((section) => section.heading),
    ['[Unreleased]'],
  );
  assert.deepEqual(sectionsSince([], '1.0.0'), []);
});

test('the version its own section leads, and older ones are left out', () => {
  const notes = renderReleaseNotes(CHANGELOG, '2.0.0', '1.2.0');
  assert.match(notes, /^# What's new in CodeBrain 2\.0\.0/);
  assert.match(notes, /_Updated from 1\.2\.0\._/);
  assert.match(notes, /## \[2\.0\.0\] - 2026-08-20/);
  assert.match(notes, /Jira and Confluence tools/);
  // Neither the unreleased work above it nor the release below it.
  assert.ok(!notes.includes('still cooking'));
  assert.ok(!notes.includes('Commit message generation'));
  assert.match(notes, /CodeBrain: What's New/);
  assert.match(notes, /codebrain\.releaseNotes\.showOnUpdate/);
});

test('work still under Unreleased is relabelled with the version installed', () => {
  // The common case: a release ships before its changelog block is promoted.
  const notes = renderReleaseNotes(CHANGELOG, '2.1.0', '2.0.0');
  assert.match(notes, /## 2\.1\.0/);
  assert.ok(!notes.includes('## [Unreleased]'), 'a page opened by an update must not say Unreleased');
  assert.match(notes, /Something still cooking/);
});

test('an empty changelog says so instead of rendering a blank page', () => {
  const notes = renderReleaseNotes('# Changelog\n\nNothing yet.\n', '1.0.0', '0.9.0');
  assert.match(notes, /ships no changelog entries/);
});
