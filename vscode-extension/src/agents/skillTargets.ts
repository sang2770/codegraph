/**
 * Installing the CodeBrain skill into agents that live outside VS Code.
 *
 * VS Code's own Copilot gets the skill from `contributes.chatSkills` — a
 * packaged file, nothing on disk to manage. Every other agent has its own
 * mechanism, and they are genuinely different, so this writes the native one
 * wherever it exists and falls back to a marked block in the agent's
 * instructions file only where it does not:
 *
 *   | Agent       | Mechanism        | Global                              | Project                                   |
 *   |-------------|------------------|-------------------------------------|-------------------------------------------|
 *   | Claude Code | skill            | `~/.claude/skills/<n>/SKILL.md`     | `<ws>/.claude/skills/<n>/SKILL.md`        |
 *   | Codex CLI   | prompt (`/<n>`)  | `~/.codex/prompts/<n>.md`           | — (no project config)                     |
 *   | Gemini CLI  | command (`/<n>`) | `~/.gemini/commands/<n>.toml`       | `<ws>/.gemini/commands/<n>.toml`          |
 *   | Antigravity | instructions     | `~/.gemini/GEMINI.md` (marked)      | — (no project config)                     |
 *   | Copilot     | instructions     | — (repository-scoped)               | `<ws>/.github/copilot-instructions.md`    |
 *
 * A marked block is the last resort on purpose: it is always loaded into the
 * agent's context, whereas a skill or slash command is loaded only when it is
 * relevant. Where an agent offers the cheaper mechanism, that is the one used.
 *
 * The skill's text is the one shipped with the extension — `skills/codebrain/
 * SKILL.md`, the same file Copilot gets — so all agents are told the same thing
 * and there is no second copy to keep in sync.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AgentTargetId, McpScope, TargetPaths, WriteAction } from './mcpTargets';
import { readMarkdownBlock, removeMarkdownBlock, upsertMarkdownBlock } from './markdownBlock';

/** Copilot has no MCP entry to write, but it does read a skill-shaped file. */
export type SkillTargetId = AgentTargetId | 'copilot';

export const SKILL_TARGET_IDS: readonly SkillTargetId[] = [
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'copilot',
];

export const SKILL_BLOCK_START = '<!-- CODEBRAIN_SKILL_START -->';
export const SKILL_BLOCK_END = '<!-- CODEBRAIN_SKILL_END -->';

export interface SkillDefinition {
  /** Slug — the directory name, the prompt file name, the slash command. */
  name: string;
  /** Human-readable heading used by the instructions-file fallback. */
  title: string;
  description: string;
  /** The whole `SKILL.md`, frontmatter included: Claude Code reads it as-is. */
  source: string;
  /** The instructions alone, which the other formats embed. */
  body: string;
}

export interface SkillArtifact {
  path: string;
  scope: McpScope;
  /** `file` is owned by us end to end; `block` shares a file with the user. */
  kind: 'file' | 'block';
}

export interface SkillWriteResult {
  target: SkillTargetId;
  displayName: string;
  scope: McpScope;
  action: WriteAction;
  path?: string;
  reason?: string;
}

export interface SkillRemoveResult {
  target: SkillTargetId;
  displayName: string;
  action: 'removed' | 'not-found' | 'skipped';
  paths: string[];
  reason?: string;
}

export interface SkillTargetDescriptor {
  id: SkillTargetId;
  displayName: string;
  detail: string;
  supported: boolean;
}

const DISPLAY_NAMES: Record<SkillTargetId, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
  copilot: 'GitHub Copilot',
};

export function skillTargetDisplayName(id: SkillTargetId): string {
  return DISPLAY_NAMES[id];
}

// ------------------------------------------------------------------ parsing

/**
 * Split a `SKILL.md` into the pieces each format needs.
 *
 * Deliberately shallow: only `name` and `description` are read, and only from
 * simple `key: value` lines. The frontmatter is authored in this repository, so
 * a full YAML parser would be a dependency bought for nothing.
 */
export function parseSkill(source: string, fallbackName: string): SkillDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  const frontmatter = match?.[1] ?? '';
  const body = (match ? source.slice(match[0].length) : source).trim();

  const field = (key: string): string | undefined => {
    const found = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(frontmatter);
    return found?.[1]?.trim().replace(/^["'](.*)["']$/, '$1');
  };

  const name = field('name') || fallbackName;
  return {
    name,
    // The body opens with the skill's own `# Heading`; use it as the title so
    // the instructions-file fallback does not invent a different name.
    title: /^#[ \t]+(.+)$/m.exec(body)?.[1]?.trim() || name,
    description: field('description') ?? '',
    source: source.trim(),
    body,
  };
}

/** Read the skill shipped inside the extension. */
export function loadSkill(extensionPath: string, name = 'codebrain'): SkillDefinition {
  const path = join(extensionPath, 'skills', name, 'SKILL.md');
  return parseSkill(readFileSync(path, 'utf8'), name);
}

// -------------------------------------------------------------- descriptors

function supportsScope(id: SkillTargetId, scope: McpScope): boolean {
  switch (id) {
    case 'claude':
    case 'gemini':
      return true;
    case 'codex':
    case 'antigravity':
      return scope === 'global';
    case 'copilot':
      // Copilot's instructions file belongs to the repository. In VS Code the
      // skill already arrives with the extension, so this is what reaches
      // Copilot everywhere else — github.com, the CLI, other editors.
      return scope === 'project';
  }
}

export function describeSkillTargets(
  skill: SkillDefinition,
  scope: McpScope,
): readonly SkillTargetDescriptor[] {
  const describe = (id: SkillTargetId): string => {
    switch (id) {
      case 'claude':
        return scope === 'global'
          ? `~/.claude/skills/${skill.name}/SKILL.md — loaded when relevant`
          : `<workspace>/.claude/skills/${skill.name}/SKILL.md — loaded when relevant`;
      case 'codex':
        return `~/.codex/prompts/${skill.name}.md — run it with /${skill.name}`;
      case 'gemini':
        return scope === 'global'
          ? `~/.gemini/commands/${skill.name}.toml — run it with /${skill.name}`
          : `<workspace>/.gemini/commands/${skill.name}.toml — run it with /${skill.name}`;
      case 'antigravity':
        return '~/.gemini/GEMINI.md — appended as a marked section';
      case 'copilot':
        return '<workspace>/.github/copilot-instructions.md — a marked section (VS Code already has the skill)';
    }
  };

  return SKILL_TARGET_IDS.map((id) => {
    const supported = supportsScope(id, scope);
    return {
      id,
      displayName: DISPLAY_NAMES[id],
      detail: supported
        ? describe(id)
        : id === 'copilot'
          ? "Copilot reads its instructions from the repository — pick the workspace scope."
          : `${DISPLAY_NAMES[id]} has no project-scoped configuration — install it globally instead.`,
      supported,
    };
  });
}

// ------------------------------------------------------------------- paths

/**
 * Every file the skill may live in for this target. Pass a `scope` to narrow
 * it; omit it to sweep both, which is what an uninstall has to do.
 */
export function skillArtifacts(
  id: SkillTargetId,
  skill: SkillDefinition,
  paths: TargetPaths,
  scope?: McpScope,
): SkillArtifact[] {
  const artifacts: SkillArtifact[] = [];
  const workspace = paths.workspaceRoot;

  switch (id) {
    case 'claude':
      artifacts.push({
        path: join(paths.homeDir, '.claude', 'skills', skill.name, 'SKILL.md'),
        scope: 'global',
        kind: 'file',
      });
      if (workspace) {
        artifacts.push({
          path: join(workspace, '.claude', 'skills', skill.name, 'SKILL.md'),
          scope: 'project',
          kind: 'file',
        });
      }
      break;
    case 'codex':
      artifacts.push({
        path: join(paths.homeDir, '.codex', 'prompts', `${skill.name}.md`),
        scope: 'global',
        kind: 'file',
      });
      break;
    case 'gemini':
      artifacts.push({
        path: join(paths.homeDir, '.gemini', 'commands', `${skill.name}.toml`),
        scope: 'global',
        kind: 'file',
      });
      if (workspace) {
        artifacts.push({
          path: join(workspace, '.gemini', 'commands', `${skill.name}.toml`),
          scope: 'project',
          kind: 'file',
        });
      }
      break;
    case 'antigravity':
      artifacts.push({
        path: join(paths.homeDir, '.gemini', 'GEMINI.md'),
        scope: 'global',
        kind: 'block',
      });
      break;
    case 'copilot':
      if (workspace) {
        artifacts.push({
          path: join(workspace, '.github', 'copilot-instructions.md'),
          scope: 'project',
          kind: 'block',
        });
      }
      break;
  }

  return scope ? artifacts.filter((artifact) => artifact.scope === scope) : artifacts;
}

// ----------------------------------------------------------------- rendering

/** The exact bytes this target's artifact should hold. */
export function renderSkill(id: SkillTargetId, skill: SkillDefinition): string {
  switch (id) {
    case 'claude':
      // Already in Claude Code's own skill format — hand it over untouched.
      return `${skill.source}\n`;
    case 'codex':
      return `${skill.description}\n\n${skill.body}\n`;
    case 'gemini':
      return `description = ${tomlBasicString(skill.description)}\nprompt = ${tomlMultilineString(skill.body)}\n`;
    case 'antigravity':
    case 'copilot':
      return `## ${skill.title}\n\n${skill.description}\n\n${stripLeadingHeading(skill.body)}`;
  }
}

/** The body without its own `# Title`, which the block supplies as `##`. */
function stripLeadingHeading(body: string): string {
  return body.replace(/^#[ \t]+.+\r?\n+/, '').trim();
}

function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * A multi-line TOML string for the prompt body.
 *
 * A literal (`'''`) string is preferred because the skill text is full of
 * backslashes and quotes that a basic string would have to escape — and an
 * escape missed here silently corrupts the prompt. It is only usable when the
 * text contains no `'''` of its own, so a basic string with full escaping is
 * kept as the fallback.
 */
function tomlMultilineString(value: string): string {
  if (!value.includes("'''") && !value.endsWith("'")) return `'''\n${value}\n'''`;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  return `"""\n${escaped}\n"""`;
}

// ------------------------------------------------------------------ install

export function installSkill(
  skill: SkillDefinition,
  id: SkillTargetId,
  paths: TargetPaths,
  scope: McpScope,
): SkillWriteResult {
  const displayName = DISPLAY_NAMES[id];
  const skip = (reason: string): SkillWriteResult => ({
    target: id,
    displayName,
    scope,
    action: 'skipped',
    reason,
  });

  if (!supportsScope(id, scope)) {
    return skip(
      id === 'copilot'
        ? 'Copilot reads its instructions from the repository; install it for the workspace instead.'
        : `${displayName} has no project-scoped configuration; install it globally instead.`,
    );
  }

  const artifact = skillArtifacts(id, skill, paths, scope)[0];
  if (!artifact) {
    return skip(`${displayName} stores this inside the workspace, and no folder is open.`);
  }

  const content = renderSkill(id, skill);
  const existed = existsSync(artifact.path);

  if (artifact.kind === 'file') {
    if (existed && readTextFile(artifact.path) === content) {
      return { target: id, displayName, scope, action: 'unchanged', path: artifact.path };
    }
    writeTextFileAtomic(artifact.path, content);
    return {
      target: id,
      displayName,
      scope,
      action: existed ? 'updated' : 'created',
      path: artifact.path,
    };
  }

  const result = upsertMarkdownBlock(
    readTextFile(artifact.path),
    SKILL_BLOCK_START,
    SKILL_BLOCK_END,
    content,
  );
  if (result.action === 'unchanged') {
    return { target: id, displayName, scope, action: 'unchanged', path: artifact.path };
  }
  writeTextFileAtomic(artifact.path, result.content);
  return {
    target: id,
    displayName,
    scope,
    action: existed ? 'updated' : 'created',
    path: artifact.path,
  };
}

/**
 * Remove the skill. With no `scope` this sweeps both, so an uninstall leaves
 * nothing behind at the scope the user is not looking at.
 */
export function removeSkill(
  skill: SkillDefinition,
  id: SkillTargetId,
  paths: TargetPaths,
  scope?: McpScope,
): SkillRemoveResult {
  const displayName = DISPLAY_NAMES[id];
  const artifacts = skillArtifacts(id, skill, paths, scope);

  if (artifacts.length === 0) {
    return {
      target: id,
      displayName,
      action: 'skipped',
      paths: [],
      reason: `${displayName} has nothing to remove at this scope.`,
    };
  }

  const touched: string[] = [];
  for (const artifact of artifacts) {
    if (!existsSync(artifact.path)) continue;

    if (artifact.kind === 'file') {
      // The file is ours end to end, so deleting it is the correct removal.
      rmSync(artifact.path, { force: true });
      touched.push(artifact.path);
      continue;
    }

    const result = removeMarkdownBlock(
      readTextFile(artifact.path),
      SKILL_BLOCK_START,
      SKILL_BLOCK_END,
    );
    if (result.action === 'removed') {
      // The rest of the file is the user's, so an emptied instructions file is
      // left in place rather than deleted.
      writeTextFileAtomic(artifact.path, result.content);
      touched.push(artifact.path);
    }
  }

  return {
    target: id,
    displayName,
    action: touched.length > 0 ? 'removed' : 'not-found',
    paths: touched.length > 0 ? touched : artifacts.map((artifact) => artifact.path),
  };
}

/**
 * The artifacts that currently hold this skill, across both scopes.
 *
 * Used to refresh after an extension update: the skill text ships with the
 * extension, so a new version leaves every installed copy out of date. Only
 * artifacts that already exist are ever rewritten — this never installs the
 * skill behind the user's back.
 */
export function readInstalledSkills(
  skill: SkillDefinition,
  id: SkillTargetId,
  paths: TargetPaths,
): { artifact: SkillArtifact; content: string }[] {
  const found: { artifact: SkillArtifact; content: string }[] = [];

  for (const artifact of skillArtifacts(id, skill, paths)) {
    if (!existsSync(artifact.path)) continue;
    const raw = readTextFile(artifact.path);

    if (artifact.kind === 'file') {
      found.push({ artifact, content: raw });
      continue;
    }
    const block = readMarkdownBlock(raw, SKILL_BLOCK_START, SKILL_BLOCK_END);
    if (block !== undefined) found.push({ artifact, content: block });
  }

  return found;
}

/** True when an installed copy no longer matches what this build would write. */
export function isSkillStale(
  installed: { artifact: SkillArtifact; content: string },
  skill: SkillDefinition,
  id: SkillTargetId,
): boolean {
  const current = renderSkill(id, skill);
  if (installed.artifact.kind === 'file') return installed.content !== current;
  return (
    installed.content !== `${SKILL_BLOCK_START}\n${current.trim()}\n${SKILL_BLOCK_END}`
  );
}

// --------------------------------------------------------------------- files

function readTextFile(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

/** Write via temp file + rename so a crash cannot leave a half-written file. */
function writeTextFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(temp, content, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The original failure is the one worth reporting.
    }
    throw error;
  }
}
