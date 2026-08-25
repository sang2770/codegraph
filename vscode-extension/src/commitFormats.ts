/**
 * The commit message formats a user can pick from, and how one becomes the
 * instructions sent to the model.
 *
 * Three layers, most specific first:
 *
 *  1. A **custom template file** in the repository, when one exists. It
 *     replaces everything here — a team that has written its convention down
 *     should not have a built-in format silently merged into it.
 *  2. The **format** chosen with `codebrain.commit.format`, plus the shared
 *     rules below, which every format needs and none should have to restate.
 *  3. The default format, so the button works before anything is configured.
 *
 * Kept free of `vscode` and `node:fs` so the composition is testable on its
 * own; the file lookup and the picker live in `commitMessage.ts`.
 */

export interface CommitFormatDefinition {
  label: string;
  /** Shown in the picker: the choice is only meaningful if you can see it. */
  example: string;
  description: string;
  /** The format-specific half of the prompt. */
  instructions: string;
}

/**
 * Rules that hold whatever the format is. They are appended to every format
 * rather than repeated inside each one, so a fix lands everywhere at once.
 */
export const SHARED_COMMIT_RULES = `## Rules

- Describe only what the diff actually changes. Never invent an issue number, a
  co-author, or a motivation the diff does not support.
- One commit, one message: summarize the whole diff rather than the first file.
- Reply with the commit message only — no code fences, no preamble, no
  explanation of your reasoning.`;

export const COMMIT_FORMATS = {
  conventional: {
    label: 'Conventional Commits',
    example: 'feat(auth): add refresh tokens',
    description: 'type(scope): summary — the convention most open-source projects use',
    instructions: `## Format

Write a Conventional Commits message:

- Subject: \`<type>(<scope>): <summary>\` — imperative mood ("add", not "added"),
  lower case after the colon, no trailing period, at most 72 characters.
- Types: feat, fix, refactor, perf, docs, test, build, ci, chore.
- Leave the scope out when the change spans several areas.
- Add a body only when the subject cannot carry the reason. Wrap it at 72
  columns and explain **why** the change was made, not what the diff already
  shows.
- Add a \`BREAKING CHANGE: <description>\` footer when a public contract
  changed.`,
  },

  'issue-summary': {
    label: 'Issue key + summary',
    example: 'TPLD-958: Fix Chart lag issue',
    description: 'ISSUE-KEY: Summary, blank line, then a nested detail list',
    instructions: `## Format

Line 1: \`<ISSUE-KEY>: <Summary>\`
Line 2: blank
Line 3 onwards: the detail list

- Take \`<ISSUE-KEY>\` from the branch name — \`feature/TPLD-958-chart-lag\`
  gives \`TPLD-958\`. When the branch carries no issue key, drop the prefix
  entirely and start with the summary; never invent a key.
- \`<Summary>\`: imperative mood, capitalized, no trailing period, at most 72
  characters.

## Detail list

Three levels, each with its own marker:

- Level 1 uses \`-\` at column 0.
  + Level 2 uses \`+\`, indented two spaces.
    * Level 3 uses \`*\`, indented four spaces.

Only go deeper when a point genuinely qualifies the one above it — most commits
need level 1 only. Each bullet is one change worth calling out, not one file.

## Example

TPLD-958: Fix Chart lag issue

- Debounce the resize handler so a drag redraws once instead of once per frame
  + Skip the redraw entirely when the new size matches the old one
- Cache the computed axis ticks between renders`,
  },

  plain: {
    label: 'Plain summary',
    example: 'Fix chart lag when the window is resized',
    description: 'One imperative sentence, with a body only when it earns one',
    instructions: `## Format

- Subject: one imperative sentence, capitalized, no trailing period, at most 72
  characters. No type prefix, no scope, no issue key.
- Add a body only when the subject cannot carry the reason. Separate it with a
  blank line, wrap at 72 columns, and explain **why** rather than what.`,
  },
} as const satisfies Record<string, CommitFormatDefinition>;

export type CommitFormatId = keyof typeof COMMIT_FORMATS;

export const DEFAULT_COMMIT_FORMAT: CommitFormatId = 'conventional';

export const COMMIT_FORMAT_IDS = Object.keys(COMMIT_FORMATS) as CommitFormatId[];

export function isCommitFormat(value: string | undefined): value is CommitFormatId {
  return value !== undefined && value in COMMIT_FORMATS;
}

/**
 * Compose the instructions for a format.
 *
 * `language` is free text rather than an enum so any language works without a
 * release; an empty value adds no rule at all, leaving the model to follow the
 * repository's own history.
 */
export function commitInstructions(
  format: CommitFormatId,
  language = '',
): string {
  const definition = COMMIT_FORMATS[format];
  const sections = [
    `# Commit message convention — ${definition.label}`,
    definition.instructions,
    SHARED_COMMIT_RULES,
  ];

  const trimmed = language.trim();
  if (trimmed) {
    sections.push(
      `## Language\n\n- Write the whole message in ${trimmed}. Keep identifiers, file paths and issue keys exactly as they are.`,
    );
  }

  return sections.join('\n\n');
}
