import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import * as vscode from 'vscode';

/**
 * One file change a report proposes.
 *
 * Reports carry these as fenced code blocks whose info string names the file
 * (` ```ts file=src/cart.ts `). The block is either the file's complete new
 * content or one or more SEARCH/REPLACE edits against its current content.
 */
export interface CodeProposal {
  /** Path relative to the project root, with forward slashes. */
  path: string;
  /** Fence language, for the diff preview; may be empty. */
  language: string;
  /** Present when the block replaces the whole file. */
  content?: string;
  /** Present when the block edits parts of the file. */
  edits?: SearchReplaceEdit[];
}

export interface SearchReplaceEdit {
  search: string;
  replace: string;
}

export type ProposalResult =
  | { ok: true; text: string; created: boolean }
  | { ok: false; error: string };

const SEARCH_MARKER = /^<{5,9} SEARCH\s*$/;
const DIVIDER_MARKER = /^={5,9}\s*$/;
const REPLACE_MARKER = /^>{5,9} REPLACE\s*$/;

/** `file=path`, `path=path` or `file="path with spaces"` in a fence info string. */
const INFO_PATH = /(?:^|\s)(?:file|path)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;

/** A `File: path` label on the line right above a fence, the other common form. */
const LABEL_PATH =
  /^\s*(?:[-*]\s*)?(?:\*\*|__)?(?:File|Path|Tệp|Tập tin)(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*`([^`]+)`\s*$/i;

/**
 * Parse the SEARCH/REPLACE edits in a block, or `undefined` when the block has
 * none and is therefore a whole-file replacement.
 */
export function parseSearchReplace(body: string): SearchReplaceEdit[] | undefined {
  const lines = body.split('\n');
  const edits: SearchReplaceEdit[] = [];
  let index = 0;
  let sawMarker = false;
  while (index < lines.length) {
    if (!SEARCH_MARKER.test(lines[index] ?? '')) {
      index += 1;
      continue;
    }
    sawMarker = true;
    const search: string[] = [];
    const replace: string[] = [];
    index += 1;
    while (index < lines.length && !DIVIDER_MARKER.test(lines[index] ?? '')) {
      search.push(lines[index] ?? '');
      index += 1;
    }
    index += 1;
    while (index < lines.length && !REPLACE_MARKER.test(lines[index] ?? '')) {
      replace.push(lines[index] ?? '');
      index += 1;
    }
    if (index >= lines.length) {
      // An unterminated edit is a model that ran out of output mid-block.
      // Applying half of it would corrupt the file, so the whole block is void.
      return [];
    }
    index += 1;
    edits.push({ search: search.join('\n'), replace: replace.join('\n') });
  }
  return sawMarker ? edits : undefined;
}

function cleanPath(value: string): string {
  return value
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/:\d+(?:-\d+)?$/, '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
}

/**
 * Every file change proposed in a report.
 *
 * Only blocks that name their file count: the handoff prompt, Mermaid
 * diagrams and illustrative snippets have no path, and a snippet without one
 * cannot be applied anywhere. A file proposed twice keeps its last block — a
 * model that revises a proposal later in the report means the revision.
 */
export function parseCodeProposals(report: string): CodeProposal[] {
  const fence = /^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm;
  const byPath = new Map<string, CodeProposal>();
  for (const match of report.matchAll(fence)) {
    const info = (match[2] ?? '').trim();
    const language = info.split(/\s+/)[0]?.replace(/[{}]/g, '') ?? '';
    if (/^(?:mermaid|text|diff|console|shell|bash|sh)$/i.test(language) && !INFO_PATH.test(info)) {
      continue;
    }
    let path: string | undefined;
    const infoMatch = INFO_PATH.exec(info);
    if (infoMatch) {
      path = infoMatch[1] ?? infoMatch[2] ?? infoMatch[3];
    } else {
      const before = report.slice(0, match.index).replace(/\s+$/, '');
      const previousLine = before.slice(before.lastIndexOf('\n') + 1);
      path = LABEL_PATH.exec(previousLine)?.[1];
    }
    if (!path) continue;
    const cleaned = cleanPath(path);
    if (!cleaned || !/[\w-]/.test(cleaned)) continue;

    const body = (match[3] ?? '').replace(/\n$/, '');
    const edits = parseSearchReplace(body);
    if (edits && edits.length === 0) continue;
    byPath.set(
      cleaned,
      edits
        ? { path: cleaned, language, edits }
        : { path: cleaned, language, content: `${body}\n` },
    );
  }
  return [...byPath.values()];
}

/** Directories a proposal must never write into. */
const PROTECTED_SEGMENTS = new Set(['.git', '.codegraph', 'node_modules']);

/**
 * The absolute path a proposal targets, or why it is refused.
 *
 * Model output decides these paths, so they are treated as untrusted: nothing
 * outside the project, and nothing inside the repository's or the index's own
 * bookkeeping.
 */
export function resolveProposalPath(
  root: string,
  path: string,
): { ok: true; absolute: string } | { ok: false; error: string } {
  if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    return { ok: false, error: `${path || '(empty path)'} is not a project-relative path` };
  }
  const absolute = normalize(join(root, path));
  const relativePath = relative(root, absolute);
  if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
    return { ok: false, error: `${path} is outside the project` };
  }
  const segments = relativePath.split(sep);
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment))) {
    return { ok: false, error: `${path} is inside ${segments.find((s) => PROTECTED_SEGMENTS.has(s))}/, which CodeBrain never edits` };
  }
  return { ok: true, absolute };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Whether every line matches once trailing whitespace is ignored. */
function looseSearch(text: string, search: string): { start: number; end: number } | undefined {
  const lines = text.split('\n');
  const wanted = search.split('\n').map((line) => line.trimEnd());
  if (wanted.length === 0) return undefined;
  const hits: number[] = [];
  for (let start = 0; start + wanted.length <= lines.length; start += 1) {
    let same = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if ((lines[start + offset] ?? '').trimEnd() !== wanted[offset]) {
        same = false;
        break;
      }
    }
    if (same) hits.push(start);
  }
  if (hits.length !== 1) return undefined;
  const first = hits[0]!;
  const startOffset = lines.slice(0, first).reduce((sum, line) => sum + line.length + 1, 0);
  const matched = lines.slice(first, first + wanted.length).join('\n');
  return { start: startOffset, end: startOffset + matched.length };
}

/**
 * The file's text after a proposal, computed against its current text.
 *
 * Every SEARCH must match exactly once. A search that matches nowhere means
 * the model quoted code that is not there (or the file moved on since); one
 * that matches twice is ambiguous. Either way the proposal is refused rather
 * than applied in a place the developer did not see in the preview.
 */
export function applyProposal(
  current: string | undefined,
  proposal: CodeProposal,
): ProposalResult {
  if (proposal.content !== undefined) {
    return { ok: true, text: proposal.content, created: current === undefined };
  }
  const edits = proposal.edits ?? [];
  if (current === undefined) {
    // A new file can only be "edited" from nothing: every SEARCH must be empty.
    if (edits.every((edit) => edit.search.trim() === '')) {
      return {
        ok: true,
        text: `${edits.map((edit) => edit.replace).join('\n')}\n`,
        created: true,
      };
    }
    return { ok: false, error: `${proposal.path} does not exist, so its SEARCH text cannot match` };
  }

  const crlf = current.includes('\r\n');
  let text = crlf ? current.replaceAll('\r\n', '\n') : current;
  for (const [index, edit] of edits.entries()) {
    const label = edits.length > 1 ? ` (edit ${index + 1} of ${edits.length})` : '';
    if (edit.search.trim() === '') {
      // An empty SEARCH against an existing file appends.
      text = `${text.replace(/\n*$/, '\n')}${edit.replace}\n`;
      continue;
    }
    const occurrences = countOccurrences(text, edit.search);
    if (occurrences === 1) {
      text = text.replace(edit.search, () => edit.replace);
      continue;
    }
    if (occurrences > 1) {
      return { ok: false, error: `${proposal.path}${label}: the SEARCH text appears ${occurrences} times` };
    }
    const loose = looseSearch(text, edit.search);
    if (!loose) {
      return { ok: false, error: `${proposal.path}${label}: the SEARCH text was not found in the current file` };
    }
    text = `${text.slice(0, loose.start)}${edit.replace}${text.slice(loose.end)}`;
  }
  return { ok: true, text: crlf ? text.replaceAll('\n', '\r\n') : text, created: false };
}

/** What `codebrain.applyCodeProposal` receives from a chat button. */
export interface ApplyProposalArgs {
  root: string;
  proposals: CodeProposal[];
  /** Shown in the confirmation, e.g. "fix" or "tests". */
  label?: string;
}

const PREVIEW_SCHEME = 'codebrain-proposal';

/** Read-only documents holding the proposed side of each preview diff. */
class ProposalPreviewProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private counter = 0;

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.query) ?? '';
  }

  public add(path: string, text: string): vscode.Uri {
    this.counter += 1;
    const id = String(this.counter);
    this.contents.set(id, text);
    // Bounded: previews are looked at once, then superseded.
    if (this.contents.size > 100) {
      const oldest = this.contents.keys().next().value;
      if (oldest !== undefined) this.contents.delete(oldest);
    }
    return vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${path}`, query: id });
  }
}

interface PreparedChange {
  proposal: CodeProposal;
  uri: vscode.Uri;
  text: string;
  created: boolean;
}

async function readCurrent(uri: vscode.Uri): Promise<string | undefined> {
  // An open editor may hold unsaved changes; the proposal must apply to what
  // the developer is looking at, not to the stale copy on disk.
  const open = vscode.workspace.textDocuments.find((document) => document.uri.fsPath === uri.fsPath);
  if (open) return open.getText();
  if (!existsSync(uri.fsPath)) return undefined;
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

async function prepare(
  args: ApplyProposalArgs,
): Promise<{ changes: PreparedChange[]; problems: string[] }> {
  const changes: PreparedChange[] = [];
  const problems: string[] = [];
  for (const proposal of args.proposals) {
    const target = resolveProposalPath(args.root, proposal.path);
    if (!target.ok) {
      problems.push(target.error);
      continue;
    }
    const uri = vscode.Uri.file(target.absolute);
    let current: string | undefined;
    try {
      current = await readCurrent(uri);
    } catch (error) {
      problems.push(`${proposal.path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const result = applyProposal(current, proposal);
    if (!result.ok) {
      problems.push(result.error);
      continue;
    }
    if (current === result.text) {
      problems.push(`${proposal.path}: already matches the proposal`);
      continue;
    }
    changes.push({ proposal, uri, text: result.text, created: result.created });
  }
  return { changes, problems };
}

async function applyChanges(changes: readonly PreparedChange[]): Promise<boolean> {
  const edit = new vscode.WorkspaceEdit();
  for (const change of changes) {
    if (change.created) {
      edit.createFile(change.uri, {
        ignoreIfExists: false,
        contents: Buffer.from(change.text, 'utf8'),
      });
      continue;
    }
    const document = await vscode.workspace.openTextDocument(change.uri);
    const whole = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length),
    );
    edit.replace(change.uri, whole, change.text);
  }
  return vscode.workspace.applyEdit(edit, { isRefactoring: false });
}

/**
 * Preview a report's proposed changes as diffs, then apply them on request.
 *
 * Nothing is written until the developer has seen the diff and said so: the
 * proposal is model output, and the preview is where a wrong one gets caught.
 * Edits to existing files are left unsaved, so the editor's own undo and the
 * dirty marker remain the developer's safety net.
 */
export async function applyCodeProposal(
  preview: ProposalPreviewProvider,
  args: ApplyProposalArgs | undefined,
  onApplied?: (files: number) => void,
): Promise<void> {
  if (!args?.root || !Array.isArray(args.proposals) || args.proposals.length === 0) {
    void vscode.window.showInformationMessage('CodeBrain: this answer has no code proposal to apply.');
    return;
  }
  const { changes, problems } = await prepare(args);
  if (changes.length === 0) {
    void vscode.window.showWarningMessage(
      `CodeBrain could not apply the proposal: ${problems.join('; ') || 'nothing to change'}.`,
    );
    return;
  }

  // Open a diff per file (bounded, so a large proposal does not flood the
  // editor) before asking anything.
  for (const change of changes.slice(0, 8)) {
    const right = preview.add(change.proposal.path, change.text);
    const left = change.created ? preview.add(`${change.proposal.path}.empty`, '') : change.uri;
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${change.proposal.path} ${change.created ? '(new file)' : ''} ↔ CodeBrain proposal`,
      { preview: changes.length === 1, preserveFocus: false },
    );
  }

  const label = args.label ? ` ${args.label}` : '';
  const summary = changes
    .map((change) => `${change.proposal.path}${change.created ? ' (new)' : ''}`)
    .join(', ');
  const skipped = problems.length ? ` Skipped: ${problems.join('; ')}.` : '';
  const choose = changes.length > 1 ? ['Choose Files…'] : [];
  const action = await vscode.window.showInformationMessage(
    `Apply the CodeBrain${label} proposal to ${changes.length} file(s)? ${summary}.${skipped}`,
    'Apply',
    ...choose,
    'Cancel',
  );
  let selected: readonly PreparedChange[] = [];
  if (action === 'Apply') {
    selected = changes;
  } else if (action === 'Choose Files…') {
    const picks = await vscode.window.showQuickPick(
      changes.map((change) => ({
        label: change.proposal.path,
        description: change.created ? 'new file' : `${change.proposal.edits?.length ?? 'whole-file'} edit(s)`,
        picked: true,
        change,
      })),
      { canPickMany: true, title: 'CodeBrain: choose the files to change', ignoreFocusOut: true },
    );
    selected = picks?.map((pick) => pick.change) ?? [];
  }
  if (selected.length === 0) return;

  // Recompute against the files as they are now: the developer may have
  // edited one while looking at its diff.
  const fresh = await prepare({
    ...args,
    proposals: selected.map((change) => change.proposal),
  });
  if (fresh.changes.length === 0) {
    void vscode.window.showWarningMessage(
      `CodeBrain did not apply the proposal: ${fresh.problems.join('; ') || 'the files changed since the preview'}.`,
    );
    return;
  }
  const applied = await applyChanges(fresh.changes);
  if (!applied) {
    void vscode.window.showErrorMessage('CodeBrain: VS Code rejected the edit; no file was changed.');
    return;
  }
  onApplied?.(fresh.changes.length);
  const edited = fresh.changes.filter((change) => !change.created);
  const after = await vscode.window.showInformationMessage(
    `CodeBrain applied the proposal to ${fresh.changes.length} file(s).${
      edited.length ? ' Edited files are unsaved — review, then save or undo.' : ''
    }${fresh.problems.length ? ` Skipped: ${fresh.problems.join('; ')}.` : ''}`,
    ...(edited.length ? ['Save Changed Files'] : []),
  );
  if (after === 'Save Changed Files') {
    for (const change of edited) {
      const document = vscode.workspace.textDocuments.find((item) => item.uri.fsPath === change.uri.fsPath);
      await document?.save();
    }
  }
}

/** Register the preview scheme and `codebrain.applyCodeProposal`. */
export function registerCodeProposals(
  context: vscode.ExtensionContext,
  onApplied?: (files: number) => void,
): void {
  const preview = new ProposalPreviewProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, preview),
    vscode.commands.registerCommand('codebrain.applyCodeProposal', (args?: ApplyProposalArgs) =>
      applyCodeProposal(preview, args, onApplied),
    ),
  );
}
