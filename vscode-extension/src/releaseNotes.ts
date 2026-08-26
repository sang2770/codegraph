/**
 * "What's new" after an extension update.
 *
 * VS Code updates extensions silently, so a release lands without the user
 * ever learning that a feature they asked for now exists. This opens the
 * changelog once per new version — and only for an actual *update*:
 *
 *  - A **first install** stores the version and shows nothing. There is no
 *    "what changed" to read, and a document opening uninvited is the wrong
 *    first impression.
 *  - An **update** shows every section published since the version the user
 *    was last on, not only the newest one — someone who skipped three releases
 *    wants all three, and that is exactly the case where they are most lost.
 *  - Re-activating on the **same version** shows nothing, however many times
 *    VS Code restarts.
 *
 * The notes are extracted into their own file rather than opening CHANGELOG.md
 * directly, so the user reads what changed *for them* instead of scrolling a
 * document that opens on the whole project's history.
 */

import * as vscode from 'vscode';

/** Where the last-seen version is remembered, across workspaces and restarts. */
const LAST_VERSION_KEY = 'codebrain.lastSeenVersion';

/** Sections shown at once. A long absence should not open a wall of text. */
const MAX_SECTIONS = 8;

/**
 * Show the notes if this activation is the first on a new version.
 *
 * Never throws: a broken changelog must not take activation down with it.
 */
export async function showReleaseNotesOnUpdate(
  context: vscode.ExtensionContext,
  log: (message: string) => void = () => {},
): Promise<void> {
  try {
    const current = currentVersion(context);
    if (!current) return;

    const previous = context.globalState.get<string>(LAST_VERSION_KEY);
    // Written before anything is shown: a failure to open the notes must not
    // put the user in a loop that reopens them on every restart.
    if (previous !== current) await context.globalState.update(LAST_VERSION_KEY, current);

    if (previous === undefined) {
      log(`[release-notes] first install of ${current}; nothing to show`);
      return;
    }
    if (previous === current) return;
    if (!showOnUpdateEnabled()) {
      log(`[release-notes] ${previous} → ${current}, suppressed by settings`);
      return;
    }

    log(`[release-notes] updated ${previous} → ${current}`);
    await showReleaseNotes(context, { since: previous, log });
  } catch (error) {
    log(`[release-notes] ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Open the notes now. Backs the "What's New" command, where the user asked for
 * them, so a missing changelog is reported rather than silently ignored.
 */
export async function showReleaseNotes(
  context: vscode.ExtensionContext,
  options: { since?: string; log?: (message: string) => void } = {},
): Promise<void> {
  const log = options.log ?? (() => {});
  const version = currentVersion(context) ?? '';
  const changelog = await readChangelog(context);

  if (!changelog) {
    void vscode.window.showInformationMessage(
      `CodeBrain ${version} is installed. The bundled changelog could not be read — see the extension's page on the Marketplace for what changed.`,
    );
    return;
  }

  const notes = renderReleaseNotes(changelog, version, options.since);
  const uri = vscode.Uri.joinPath(context.globalStorageUri, `whats-new-${version || 'latest'}.md`);
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(notes, 'utf8'));
  await vscode.commands.executeCommand('markdown.showPreview', uri);
  log(`[release-notes] opened ${uri.fsPath}`);
}

// ------------------------------------------------------------------ parsing

/** One `## …` block of a Keep-a-Changelog-shaped file. */
export interface ChangelogSection {
  heading: string;
  body: string;
}

/**
 * Split a changelog into its `## …` sections, newest first.
 *
 * Anything above the first `## ` (the title, a preamble) is dropped: it is the
 * same in every release and says nothing about what changed.
 */
export function splitSections(changelog: string): ChangelogSection[] {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | undefined;

  for (const line of lines) {
    // `###` sub-headings belong to the section they sit in, so match `##` only.
    if (/^##(?!#)\s+/.test(line)) {
      if (current) sections.push(current);
      current = { heading: line.replace(/^##\s+/, '').trim(), body: '' };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) sections.push(current);

  return sections.map((section) => ({ heading: section.heading, body: section.body.trim() }));
}

/** Whether a heading names this version, in either `[1.2.3]` or `1.2.3` form. */
export function headingMatchesVersion(heading: string, version: string): boolean {
  if (!version) return false;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[[\\s])v?${escaped}([\\]\\s]|$)`).test(heading);
}

/**
 * The sections published between two versions, newest first.
 *
 * Everything above the section naming `since` is what the user has not seen.
 * When `since` is not in the file — an old install, or a changelog that has
 * been rewritten — only the newest section is returned: showing the entire
 * history instead would bury the thing they just got.
 */
export function sectionsSince(
  sections: readonly ChangelogSection[],
  since: string | undefined,
): ChangelogSection[] {
  if (sections.length === 0) return [];

  const index = since
    ? sections.findIndex((section) => headingMatchesVersion(section.heading, since))
    : -1;
  if (index <= 0) return sections.slice(0, 1);
  return sections.slice(0, Math.min(index, MAX_SECTIONS));
}

/**
 * Build the document the user reads.
 *
 * The current version's own section leads when the changelog has one. Many
 * releases ship with the work still under `Unreleased` — the section is then
 * relabelled with the version actually installed, because "Unreleased" on a
 * page opened *by* an update reads as a bug.
 */
export function renderReleaseNotes(
  changelog: string,
  version: string,
  since?: string,
): string {
  const sections = splitSections(changelog);
  const own = sections.findIndex((section) => headingMatchesVersion(section.heading, version));
  const selected = own >= 0 ? sections.slice(own, own + 1) : sectionsSince(sections, since);

  const lines = [`# What's new in CodeBrain ${version}`.trimEnd(), ''];
  if (since && since !== version) lines.push(`_Updated from ${since}._`, '');

  if (selected.length === 0) {
    lines.push('This release ships no changelog entries.');
    return `${lines.join('\n')}\n`;
  }

  for (const section of selected) {
    const unreleased = /unreleased/i.test(section.heading);
    lines.push(`## ${unreleased && version ? version : section.heading}`, '', section.body, '');
  }

  lines.push(
    '---',
    '',
    'Open this again any time with **CodeBrain: What\'s New**. To stop it opening after an update, turn off `codebrain.releaseNotes.showOnUpdate`.',
  );
  return `${lines.join('\n')}\n`;
}

// ----------------------------------------------------------------- plumbing

function currentVersion(context: vscode.ExtensionContext): string | undefined {
  const version = (context.extension?.packageJSON as { version?: string } | undefined)?.version;
  return typeof version === 'string' && version ? version : undefined;
}

function showOnUpdateEnabled(): boolean {
  return (
    vscode.workspace
      .getConfiguration('codebrain')
      .get<boolean>('releaseNotes.showOnUpdate', true) !== false
  );
}

async function readChangelog(context: vscode.ExtensionContext): Promise<string | undefined> {
  const uri = vscode.Uri.joinPath(context.extensionUri, 'CHANGELOG.md');
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return undefined;
  }
}
