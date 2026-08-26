#!/usr/bin/env node
/**
 * Promote `## [Unreleased]` into `## [<version>] - <date>` in CHANGELOG.md.
 *
 * Two readers depend on this having happened before a release goes out:
 *
 *  - **The marketplace page**, which renders this file as the extension's
 *    Changelog tab. A published version that appears there only under
 *    "Unreleased" reads as an unfinished release.
 *  - **The extension itself.** `src/releaseNotes.ts` opens a "What's new" page
 *    after an update and looks for the section naming the installed version.
 *    It falls back to the top section and relabels it, so an unpromoted
 *    changelog still shows the right text — but only because of that fallback,
 *    and only for the newest release. Someone updating across two releases
 *    gets the boundary wrong.
 *
 * Idempotent, so a re-run of a failed release workflow is safe:
 *
 *   Case A — no `[<version>]` block yet: rename `[Unreleased]` to
 *     `[<version>] - <YYYY-MM-DD>` and open a fresh empty `[Unreleased]`
 *     above it. The normal path.
 *   Case B — `[<version>]` already exists and `[Unreleased]` has entries:
 *     merge each `### …` sub-section of Unreleased into the matching one of
 *     `[<version>]`, appending any that have no counterpart, then empty
 *     Unreleased. Sub-headings are matched in full, so `### New Features`
 *     merges with `### New Features` rather than being treated as unmatched.
 *   Case C — nothing to promote: no-op.
 *
 * Usage:
 *   node scripts/prepare-release.mjs               # version from package.json
 *   node scripts/prepare-release.mjs 2.0.6         # explicit version
 *   node scripts/prepare-release.mjs --check       # report only, never write
 *   node scripts/prepare-release.mjs --allow-empty # tolerate a release with no notes
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDir, '..');

// ------------------------------------------------------------------ parsing

/** One `## [name]` block, kept line-exact so re-joining changes nothing else. */
function parseChangelog(text) {
  const lines = text.split('\n');
  const headingRe = /^## \[([^\]]+)\](?:\s+-\s+(.+))?\s*$/;
  const preface = [];
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const match = line.match(headingRe);
    if (match) {
      if (current) blocks.push(current);
      current = { header: line, name: match[1], body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      preface.push(line);
    }
  }
  if (current) blocks.push(current);
  return { preface, blocks };
}

function joinChangelog({ preface, blocks }) {
  return [
    preface.join('\n'),
    ...blocks.map((block) => [block.header, ...block.body].join('\n')),
  ].join('\n');
}

/**
 * Split a block into its `### …` sub-sections.
 *
 * The heading is captured in full rather than as a single word: this
 * changelog uses `### New Features` and `### Fixes`, and a word-only match
 * would fail to pair them up and duplicate the heading on every merge.
 */
function splitSubsections(body) {
  const headingRe = /^###\s+(.+?)\s*$/;
  const leading = [];
  const subs = [];
  let current = null;

  for (const line of body) {
    const match = line.match(headingRe);
    if (match) {
      if (current) subs.push(current);
      current = { heading: match[1], headerLine: line, body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      leading.push(line);
    }
  }
  if (current) subs.push(current);
  return { leading, subs };
}

function rebuildBody({ leading, subs }) {
  const parts = [];
  if (leading.length > 0) parts.push(leading.join('\n'));
  for (const sub of subs) parts.push([sub.headerLine, ...sub.body].join('\n'));
  return parts.join('\n').split('\n');
}

const isEntry = (line) => /^\s*([-*]|\d+\.)\s+/.test(line);

/** Entry lines in a body. Sub-headings with nothing under them do not count. */
function countEntries(body) {
  return body.filter(isEntry).length;
}

function trimTrailingBlank(lines) {
  let end = lines.length;
  while (end > 0 && /^\s*$/.test(lines[end - 1])) end -= 1;
  return lines.slice(0, end);
}

/**
 * Drop blank lines from both ends.
 *
 * Used on entries being merged into an existing sub-section: their body still
 * carries the blank line that separated them from their own `###` heading, and
 * keeping it alongside the separator this code adds would leave a widening gap
 * between entries on every merge.
 */
function trimBlankEdges(lines) {
  let start = 0;
  while (start < lines.length && /^\s*$/.test(lines[start])) start += 1;
  return trimTrailingBlank(lines.slice(start));
}

// ---------------------------------------------------------------- promotion

/**
 * Promote a changelog for `version`.
 *
 * Pure: takes and returns text, so the release workflow and the tests
 * exercise the same code path.
 *
 * @returns {{text: string, changed: boolean, mode: 'promoted'|'merged'|'noop',
 *            reason: string, entries: number}}
 */
export function promoteChangelog(text, version, options = {}) {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const parsed = parseChangelog(text);

  const unreleasedIndex = parsed.blocks.findIndex((block) => block.name === 'Unreleased');
  const versionIndex = parsed.blocks.findIndex((block) => block.name === version);
  const unreleased = unreleasedIndex >= 0 ? parsed.blocks[unreleasedIndex] : undefined;
  const pending = unreleased ? countEntries(unreleased.body) : 0;

  if (pending === 0) {
    return {
      text,
      changed: false,
      mode: 'noop',
      entries: 0,
      reason:
        versionIndex >= 0
          ? `[${version}] is already promoted`
          : unreleased
            ? '[Unreleased] has no entries'
            : 'there is no [Unreleased] block',
    };
  }

  if (versionIndex === -1) {
    // Case A.
    const promoted = {
      header: `## [${version}] - ${date}`,
      name: version,
      body: trimTrailingBlank(unreleased.body).concat(['']),
    };
    const emptied = { header: '## [Unreleased]', name: 'Unreleased', body: ['', ''] };
    parsed.blocks.splice(unreleasedIndex, 1, emptied, promoted);
    return {
      text: joinChangelog(parsed),
      changed: true,
      mode: 'promoted',
      entries: pending,
      reason: `renamed [Unreleased] to [${version}] - ${date}`,
    };
  }

  // Case B — fold Unreleased into the block someone already started.
  const target = parsed.blocks[versionIndex];
  const incoming = splitSubsections(unreleased.body);
  const existing = splitSubsections(target.body);

  for (const sub of incoming.subs) {
    const body = trimTrailingBlank(sub.body);
    if (body.length === 0) continue;
    const match = existing.subs.find((candidate) => candidate.heading === sub.heading);
    if (match) {
      const kept = trimTrailingBlank(match.body);
      const separator = kept.length > 0 && !/^\s*$/.test(kept[kept.length - 1]) ? [''] : [];
      match.body = kept.concat(separator, trimBlankEdges(body), ['']);
    } else {
      existing.subs.push({
        heading: sub.heading,
        headerLine: sub.headerLine,
        body: body.concat(['']),
      });
    }
  }

  // Entries written directly under the heading, with no sub-section of their
  // own, would be dropped by the loop above — carry them over as leading text.
  const looseEntries = trimTrailingBlank(incoming.leading).filter(isEntry);
  if (looseEntries.length > 0) {
    existing.leading = trimTrailingBlank(existing.leading).concat([''], looseEntries, ['']);
  }

  target.body = rebuildBody(existing);
  unreleased.body = ['', ''];

  return {
    text: joinChangelog(parsed),
    changed: true,
    mode: 'merged',
    entries: pending,
    reason: `merged ${pending} entr${pending === 1 ? 'y' : 'ies'} into the existing [${version}] block`,
  };
}

// --------------------------------------------------------------------- CLI

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const allowEmpty = args.includes('--allow-empty');
  const version =
    args.find((arg) => !arg.startsWith('--')) ??
    JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf8')).version;

  if (!version) throw new Error('package.json has no "version" field.');

  const path = join(extensionRoot, 'CHANGELOG.md');
  const original = readFileSync(path, 'utf8');
  const result = promoteChangelog(original, version);

  if (!result.changed) {
    const promoted = original.includes(`## [${version}]`);
    if (!promoted && !allowEmpty) {
      // Publishing with nothing to say is nearly always a forgotten changelog
      // entry, and it is the users of "What's new" who pay for it.
      throw new Error(
        `Nothing to release for ${version}: ${result.reason}. ` +
          'Add entries under ## [Unreleased], or pass --allow-empty to ship without notes.',
      );
    }
    console.log(`prepare-release: ${version} — ${result.reason}, nothing to do`);
    return;
  }

  if (check) {
    console.log(`prepare-release: ${version} — would ${result.reason} (--check, not written)`);
    process.exitCode = 1;
    return;
  }

  writeFileSync(path, result.text);
  console.log(`prepare-release: ${version} — ${result.reason}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`prepare-release: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
