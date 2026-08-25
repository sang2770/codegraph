/**
 * Generating a commit message from the changes in the Source Control view.
 *
 * The message is written straight into the SCM input box, which means going
 * through the built-in Git extension's API — that box belongs to its
 * `SourceControl`, and there is no VS Code API to write another provider's
 * input. When the Git extension is unavailable the message goes to the
 * clipboard instead of being lost.
 *
 * What the model is told is configurable in three layers, most specific first:
 * a **custom template file** in the repository (`.codebrain/commit-template.md`
 * by default), the **format** picked with `CodeBrain: Choose Commit Message
 * Format`, and the default format so the button works before anything is
 * configured. `commitFormats.ts` owns the formats themselves.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import * as vscode from 'vscode';
import {
  COMMIT_FORMATS,
  COMMIT_FORMAT_IDS,
  CommitFormatId,
  DEFAULT_COMMIT_FORMAT,
  commitInstructions,
  isCommitFormat,
} from './commitFormats';
import { collectGitReviewContext } from './gitContext';
import { selectCodeBrainModel } from './modelSelection';
import { runProcess } from './runtime';
import { getWorkspaceFolder } from './workspace';

const DEFAULT_TEMPLATE_FILE = '.codebrain/commit-template.md';
const DEFAULT_MAX_DIFF_CHARACTERS = 60_000;

/**
 * Prepended when the template file is first created. It says the one thing a
 * reader cannot guess: this file is the whole instruction, so a rule deleted
 * here stops being applied — the chosen format does not come back to fill the
 * gap.
 */
const TEMPLATE_HEADER = `<!--
CodeBrain commit template.

Everything below is sent to the model together with your staged diff, the
current branch name and the last few commit subjects. It REPLACES the format
chosen in settings, so a rule you delete here simply stops being applied.

Delete this file to go back to the format picked with
"CodeBrain: Choose Commit Message Format".
-->`;

// --------------------------------------------------------- git extension API

/** The slice of the built-in Git extension's API this module relies on. */
interface GitRepositoryLike {
  rootUri: vscode.Uri;
  inputBox: { value: string };
}

interface GitApiLike {
  repositories: GitRepositoryLike[];
}

interface GitExtensionLike {
  getAPI(version: 1): GitApiLike;
}

async function gitApi(): Promise<GitApiLike | undefined> {
  const extension = vscode.extensions.getExtension<GitExtensionLike>('vscode.git');
  if (!extension) return undefined;
  try {
    // Activating explicitly rather than trusting `isActive`: the command can
    // run before the Git extension has finished starting, and an early return
    // there would silently downgrade to the clipboard fallback.
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports.getAPI(1);
  } catch {
    // A Git extension that fails to start, or refuses this API version, is one
    // we cannot drive — the caller falls back to the clipboard.
    return undefined;
  }
}

/**
 * The repository the button was clicked on.
 *
 * `scm/title` passes VS Code's `SourceControl`, whose `rootUri` identifies the
 * repository — which matters in a multi-root window, where the first
 * repository in the list is often not the one the user is looking at.
 */
function resolveRepository(
  api: GitApiLike | undefined,
  argument: unknown,
): GitRepositoryLike | undefined {
  if (!api || api.repositories.length === 0) return undefined;

  const rootUri = (argument as { rootUri?: vscode.Uri } | undefined)?.rootUri;
  if (rootUri) {
    const matched = api.repositories.find(
      (repository) => repository.rootUri.toString() === rootUri.toString(),
    );
    if (matched) return matched;
  }

  const folder = getWorkspaceFolder();
  if (folder) {
    const matched = api.repositories.find(
      (repository) => repository.rootUri.fsPath === folder.uri.fsPath,
    );
    if (matched) return matched;
  }

  return api.repositories[0];
}

// ------------------------------------------------------------------ template

function templatePath(root: vscode.Uri): string {
  const configured = (
    vscode.workspace
      .getConfiguration('codebrain', root)
      .get<string>('commit.templateFile', DEFAULT_TEMPLATE_FILE) ?? DEFAULT_TEMPLATE_FILE
  ).trim();
  return resolve(
    root.fsPath,
    isAbsolute(configured) ? configured : configured || DEFAULT_TEMPLATE_FILE,
  );
}

/** The format currently selected for this repository. */
function configuredFormat(root: vscode.Uri): CommitFormatId {
  const configured = vscode.workspace
    .getConfiguration('codebrain', root)
    .get<string>('commit.format', DEFAULT_COMMIT_FORMAT)
    ?.trim();
  return isCommitFormat(configured) ? configured : DEFAULT_COMMIT_FORMAT;
}

/** The instructions a built-in format produces for this repository. */
function builtInInstructions(root: vscode.Uri): string {
  const language = vscode.workspace
    .getConfiguration('codebrain', root)
    .get<string>('commit.language', '') ?? '';
  return commitInstructions(configuredFormat(root), language);
}

/** A custom template file's contents, when the repository has a usable one. */
function customTemplate(root: vscode.Uri): string | undefined {
  const path = templatePath(root);
  try {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf8').trim();
      if (content) return content;
    }
  } catch {
    // An unreadable template must not block the commit — fall through to the
    // chosen format, which is what an unconfigured repository uses anyway.
  }
  return undefined;
}

/**
 * What the model is told, and where it came from.
 *
 * A custom file replaces the built-in format outright rather than being merged
 * into it: a team that wrote its convention down should not have to work out
 * which half of the prompt is theirs.
 */
function resolveInstructions(root: vscode.Uri): { text: string; custom: boolean } {
  const custom = customTemplate(root);
  return custom
    ? { text: custom, custom: true }
    : { text: builtInInstructions(root), custom: false };
}

/**
 * The directory the template is resolved against.
 *
 * The repository root, not the workspace folder — opening a sub-directory of a
 * repository is normal (a monorepo package, this extension inside its own
 * repo), and resolving the two commands differently would have the editor
 * create a template the generator never reads.
 */
async function templateRoot(argument?: unknown): Promise<vscode.Uri | undefined> {
  const repository = resolveRepository(await gitApi(), argument);
  return repository?.rootUri ?? getWorkspaceFolder()?.uri;
}

/** Create the template if it does not exist yet, then open it for editing. */
export async function editCommitTemplate(argument?: unknown): Promise<void> {
  const root = await templateRoot(argument);
  if (!root) {
    void vscode.window.showWarningMessage(
      'Open a workspace before customizing the CodeBrain commit template.',
    );
    return;
  }

  const path = templatePath(root);
  if (!existsSync(path)) {
    // Seeded from the format currently in effect, so editing starts from what
    // the button already produces instead of from a blank page.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${TEMPLATE_HEADER}\n\n${builtInInstructions(root)}\n`, 'utf8');
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  await vscode.window.showTextDocument(document, { preview: false });
}

/**
 * Pick the commit message format, or switch to a hand-written template.
 *
 * The example is carried in the label rather than hidden behind a description,
 * because "Conventional Commits" means nothing to someone who has not met it
 * and `feat(auth): add refresh tokens` means everything.
 */
export async function selectCommitFormat(argument?: unknown): Promise<void> {
  const root = await templateRoot(argument);
  if (!root) {
    void vscode.window.showWarningMessage(
      'Open a workspace before choosing a CodeBrain commit message format.',
    );
    return;
  }

  const active = configuredFormat(root);
  const custom = customTemplate(root) !== undefined;

  const items: (vscode.QuickPickItem & { format?: CommitFormatId; edit?: true })[] =
    COMMIT_FORMAT_IDS.map((id) => ({
      label: COMMIT_FORMATS[id].example,
      description: `${COMMIT_FORMATS[id].label}${!custom && id === active ? ' · current' : ''}`,
      detail: COMMIT_FORMATS[id].description,
      format: id,
    }));

  items.push({
    label: '$(edit) Custom template…',
    description: custom ? 'current' : undefined,
    detail: custom
      ? `${templatePath(root)} — overrides the formats above. Delete it to use one of them again.`
      : 'Write the convention yourself, starting from the format selected above.',
    edit: true,
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'CodeBrain: commit message format',
    placeHolder: custom
      ? 'A custom template is in use — picking a format below has no effect until you delete it'
      : 'Used when CodeBrain writes your commit message',
  });
  if (!picked) return;

  if (picked.edit) {
    await editCommitTemplate(argument);
    return;
  }

  await vscode.workspace
    .getConfiguration('codebrain', root)
    .update('commit.format', picked.format, vscode.ConfigurationTarget.Workspace);

  if (custom) {
    // Saying nothing here would leave the user believing the pick took effect.
    const choice = await vscode.window.showWarningMessage(
      `Format set to ${COMMIT_FORMATS[picked.format!].label}, but this repository's custom template still overrides it.`,
      'Open template',
    );
    if (choice === 'Open template') await editCommitTemplate(argument);
    return;
  }

  void vscode.window.showInformationMessage(
    `CodeBrain will write commit messages as: ${COMMIT_FORMATS[picked.format!].example}`,
  );
}

// -------------------------------------------------------------------- prompt

interface CommitChanges {
  diff: string;
  stat: string;
  files: string[];
  staged: boolean;
  truncated: boolean;
  /**
   * The current branch. Many conventions take the issue key from it
   * (`feature/TPLD-958-chart-lag` → `TPLD-958`), which is impossible to do
   * from the diff alone.
   */
  branch?: string;
  /** Recent subjects, so a template can be matched against real history. */
  recentSubjects: string[];
}

/**
 * The changes the message should describe.
 *
 * Staged changes win: that is exactly what the next commit will contain, and
 * describing an unstaged edit the user deliberately left out would be wrong.
 * With nothing staged, everything in the worktree is used — Git commits that
 * with `-a`, and it is what the user sees in the view they clicked from.
 */
async function collectChanges(
  root: string,
  maxDiffCharacters: number,
): Promise<CommitChanges> {
  const [staged, branch, history] = await Promise.all([
    runProcess(
      'git',
      ['diff', '--relative', '--cached', '--no-ext-diff', '--no-color', '--unified=8', '--'],
      { cwd: root, maxOutputCharacters: maxDiffCharacters },
    ),
    runProcess('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      maxOutputCharacters: 1000,
    }),
    runProcess('git', ['log', '-8', '--format=%s'], {
      cwd: root,
      maxOutputCharacters: 4000,
    }),
  ]);

  // A detached HEAD reports `HEAD`, which is not a branch name and carries no
  // issue key — better to send nothing than to have the model read into it.
  const branchName = branch.code === 0 ? branch.stdout.trim() : '';
  const shared = {
    branch: branchName && branchName !== 'HEAD' ? branchName : undefined,
    recentSubjects: history.code === 0 ? splitLines(history.stdout).slice(0, 8) : [],
  };

  if (staged.code === 0 && staged.stdout.trim()) {
    const [stat, files] = await Promise.all([
      runProcess('git', ['diff', '--relative', '--cached', '--stat', '--'], {
        cwd: root,
        maxOutputCharacters: 20_000,
      }),
      runProcess('git', ['diff', '--relative', '--cached', '--name-only', '--'], {
        cwd: root,
        maxOutputCharacters: 20_000,
      }),
    ]);
    return {
      ...shared,
      diff: staged.stdout.trim(),
      stat: stat.stdout.trim(),
      files: splitLines(files.stdout),
      staged: true,
      truncated: staged.truncated,
    };
  }

  const context = await collectGitReviewContext(root, maxDiffCharacters);
  return {
    ...shared,
    diff: context.diff,
    stat: context.stat,
    files: context.changedFiles,
    staged: false,
    truncated: context.truncated,
  };
}

function splitLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function commitPrompt(template: string, changes: CommitChanges): string {
  const sections = [
    'You are writing the Git commit message for the change below.',
    '',
    '## Instructions',
    '',
    template,
    '',
    '## Repository',
    '',
    changes.branch ? `Current branch: ${changes.branch}` : 'Current branch: unknown (detached HEAD).',
    changes.recentSubjects.length > 0
      ? `\nRecent commit subjects, newest first — context on the existing style. The instructions above win wherever they disagree:\n${changes.recentSubjects
          .map((subject) => `- ${subject}`)
          .join('\n')}`
      : '',
    '',
    `## Changes (${changes.staged ? 'staged' : 'not staged yet — the whole working tree'})`,
    '',
    changes.files.length > 0 ? `Files:\n${changes.files.map((file) => `- ${file}`).join('\n')}` : '',
    changes.stat ? `\nSummary:\n\`\`\`\n${changes.stat}\n\`\`\`` : '',
    `\nDiff:\n\`\`\`diff\n${changes.diff}\n\`\`\``,
  ];

  if (changes.truncated) {
    sections.push(
      '',
      'The diff above was truncated. Describe the change at a level the visible part supports, and do not guess at what was cut off.',
    );
  }

  return sections.filter((section) => section !== '').join('\n');
}

/**
 * Take the commit message out of whatever the model wrapped it in.
 *
 * Models routinely answer with a fenced block or a "Here's the message:" lead
 * even when told not to, and that text pasted into the input box would be
 * committed verbatim.
 */
export function cleanCommitMessage(raw: string): string {
  let text = raw.trim();

  const fenced = /^```[\w-]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text);
  if (fenced) text = fenced[1]!.trim();

  text = text.replace(/^(?:here(?:'s| is) the )?commit message:?\s*\r?\n+/i, '');
  // A model that quotes the whole message adds a wrapping pair of quotes.
  const quoted = /^"([\s\S]+)"$/.exec(text);
  if (quoted && !quoted[1]!.includes('"')) text = quoted[1]!;

  return text.trim();
}

// ------------------------------------------------------------------ command

export async function generateCommitMessage(argument?: unknown): Promise<void> {
  const api = await gitApi();
  const repository = resolveRepository(api, argument);
  const folder = getWorkspaceFolder();
  const root = repository?.rootUri ?? folder?.uri;

  if (!root) {
    void vscode.window.showWarningMessage(
      'CodeBrain: open a Git repository before generating a commit message.',
    );
    return;
  }

  const config = vscode.workspace.getConfiguration('codebrain', root);
  const maxDiffCharacters = config.get<number>(
    'commit.maxDiffCharacters',
    DEFAULT_MAX_DIFF_CHARACTERS,
  );

  const message = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.SourceControl,
      title: 'CodeBrain: writing a commit message…',
      cancellable: true,
    },
    async (_progress, token) => {
      const changes = await collectChanges(root.fsPath, maxDiffCharacters);
      if (token.isCancellationRequested) return undefined;
      if (!changes.diff.trim()) {
        void vscode.window.showInformationMessage(
          'CodeBrain: there are no changes to describe yet.',
        );
        return undefined;
      }

      const model = await selectCodeBrainModel();
      if (!model) {
        void vscode.window.showErrorMessage(
          'No AI model is available. Sign in to a model provider or run “CodeBrain: Choose AI Model”, then try again.',
        );
        return undefined;
      }

      const request = await model.sendRequest(
        [
          vscode.LanguageModelChatMessage.User(
            commitPrompt(resolveInstructions(root).text, changes),
          ),
        ],
        {},
        token,
      );

      let raw = '';
      for await (const fragment of request.text) {
        raw += fragment;
      }
      return cleanCommitMessage(raw);
    },
  );

  if (message === undefined) return;
  if (!message) {
    void vscode.window.showWarningMessage(
      'CodeBrain: the model returned an empty commit message. Try again, or pick another model.',
    );
    return;
  }

  if (!repository) {
    // No Git extension to write to — the message is still the useful part.
    await vscode.env.clipboard.writeText(message);
    void vscode.window.showInformationMessage(
      'CodeBrain copied the commit message to your clipboard — the built-in Git extension is not available to fill the input box.',
    );
    return;
  }

  const previous = repository.inputBox.value;
  repository.inputBox.value = message;

  // Replacing what someone typed is the one destructive thing here, so it is
  // offered back rather than confirmed up front — the button stays one click.
  if (previous.trim()) {
    void vscode.window
      .showInformationMessage('CodeBrain replaced the commit message.', 'Undo')
      .then((choice) => {
        if (choice === 'Undo') repository.inputBox.value = previous;
      });
  }
}
