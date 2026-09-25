/**
 * Installing the CodeBrain skills into agents that live outside VS Code.
 *
 * VS Code's own Copilot gets the skill from `contributes.chatSkills` — a
 * packaged file, nothing on disk to manage. Every other agent now reads the
 * same open Agent Skills format — a `<name>/SKILL.md` folder, loaded only when
 * its description matches the task — so each one gets a native skill, never a
 * block pasted into an always-loaded instructions file:
 *
 *   | Agent       | Global                                 | Project                              |
 *   |-------------|----------------------------------------|--------------------------------------|
 *   | Claude Code | `~/.claude/skills/<n>/SKILL.md`        | `<ws>/.claude/skills/<n>/SKILL.md`   |
 *   | Codex CLI   | `~/.agents/skills/<n>/SKILL.md`        | `<ws>/.agents/skills/<n>/SKILL.md`   |
 *   | Gemini CLI  | `~/.gemini/skills/<n>/SKILL.md`        | `<ws>/.gemini/skills/<n>/SKILL.md`   |
 *   | Antigravity | `~/.gemini/config/skills/<n>/SKILL.md` | `<ws>/.agents/skills/<n>/SKILL.md`   |
 *   | Copilot     | `~/.copilot/skills/<n>/SKILL.md`       | `<ws>/.github/skills/<n>/SKILL.md`   |
 *   | Cursor      | `~/.cursor/skills/<n>/SKILL.md`        | `<ws>/.cursor/skills/<n>/SKILL.md`   |
 *   | opencode    | `~/.config/opencode/skills/<n>/…`      | `<ws>/.opencode/skills/<n>/SKILL.md` |
 *
 * Antigravity's global path is `~/.gemini/config/skills/`, the one location its
 * IDE, CLI and agent manager all read. Codex and Antigravity share the
 * workspace's `.agents/skills/`: the same bytes serve both, and removing one
 * leaves nothing the other still needs that the other's install would not
 * rewrite.
 *
 * Earlier releases used each agent's older mechanism — a Codex prompt, a Gemini
 * slash command, marked sections in `~/.gemini/GEMINI.md` and
 * `.github/copilot-instructions.md`. Those are `legacy` artifacts now: an
 * install or refresh replaces them with the native skill, and an uninstall
 * sweeps them along with it.
 *
 * The skills' text is the one shipped with the extension — `skills/<name>/
 * SKILL.md` (the general `codebrain` skill plus the explain / implement / fix /
 * review workflows), the same files Copilot gets — so all agents are told the
 * same thing and there is no second copy to keep in sync.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AgentTargetId, McpScope, TargetPaths, WriteAction } from './mcpTargets';
import { readMarkdownBlock, removeMarkdownBlock } from './markdownBlock';
import { CODEBRAIN_SKILL_NAMES, readSkill, SkillDefinition } from './skillFormat';

export type { SkillDefinition } from './skillFormat';
export { CODEBRAIN_SKILL_NAMES, parseSkill } from './skillFormat';

/** Every agent that takes a skill — the MCP targets plus nothing else. */
export type SkillTargetId = AgentTargetId;

export const SKILL_TARGET_IDS: readonly SkillTargetId[] = [
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'copilot',
  'cursor',
  'opencode',
];

export const SKILL_BLOCK_START = '<!-- CODEBRAIN_SKILL_START -->';
export const SKILL_BLOCK_END = '<!-- CODEBRAIN_SKILL_END -->';

export interface SkillArtifact {
  path: string;
  scope: McpScope;
  /**
   * `file` is the native skill, owned by us end to end. `legacy-file` and
   * `legacy-block` are what earlier releases wrote — a file of ours, or a
   * marked section in a file the user shares with us.
   */
  kind: 'file' | 'legacy-file' | 'legacy-block';
}

export interface SkillWriteResult {
  target: SkillTargetId;
  displayName: string;
  scope: McpScope;
  action: WriteAction;
  path?: string;
  reason?: string;
  /** Older-format copies this install replaced. */
  migrated?: string[];
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
  cursor: 'Cursor',
  opencode: 'opencode',
};

export function skillTargetDisplayName(id: SkillTargetId): string {
  return DISPLAY_NAMES[id];
}

// ------------------------------------------------------------------ loading

/** Read one skill shipped inside the extension. */
export function loadSkill(extensionPath: string, name = 'codebrain'): SkillDefinition {
  return readSkill(join(extensionPath, 'skills'), name);
}

/**
 * Every skill shipped inside the extension: the general tool guidance plus the
 * four developer-workflow playbooks (explain, implement, fix, review).
 */
export function loadSkills(extensionPath: string): SkillDefinition[] {
  return CODEBRAIN_SKILL_NAMES.map((name) => loadSkill(extensionPath, name));
}

// -------------------------------------------------------------- descriptors

/** The skills directory for each target, at each scope, relative to its root. */
const SKILL_ROOTS: Record<SkillTargetId, { global: string[]; project: string[] }> = {
  claude: { global: ['.claude', 'skills'], project: ['.claude', 'skills'] },
  codex: { global: ['.agents', 'skills'], project: ['.agents', 'skills'] },
  gemini: { global: ['.gemini', 'skills'], project: ['.gemini', 'skills'] },
  antigravity: { global: ['.gemini', 'config', 'skills'], project: ['.agents', 'skills'] },
  copilot: { global: ['.copilot', 'skills'], project: ['.github', 'skills'] },
  cursor: { global: ['.cursor', 'skills'], project: ['.cursor', 'skills'] },
  opencode: { global: ['.config', 'opencode', 'skills'], project: ['.opencode', 'skills'] },
};

export function describeSkillTargets(
  skill: SkillDefinition,
  scope: McpScope,
): readonly SkillTargetDescriptor[] {
  return SKILL_TARGET_IDS.map((id) => {
    const root = scope === 'global' ? `~/${SKILL_ROOTS[id].global.join('/')}` : `<workspace>/${SKILL_ROOTS[id].project.join('/')}`;
    return {
      id,
      displayName: DISPLAY_NAMES[id],
      detail: `${root}/${skill.name}/SKILL.md — loaded when relevant`,
      supported: true,
    };
  });
}

// ------------------------------------------------------------------- paths

function nativeArtifact(
  id: SkillTargetId,
  skill: SkillDefinition,
  paths: TargetPaths,
  scope: McpScope,
): SkillArtifact | undefined {
  const base = scope === 'global' ? paths.homeDir : paths.workspaceRoot;
  if (!base) return undefined;
  return { path: join(base, ...SKILL_ROOTS[id][scope], skill.name, 'SKILL.md'), scope, kind: 'file' };
}

/** What earlier releases wrote for this target — replaced on install, swept on removal. */
function legacyArtifacts(id: SkillTargetId, skill: SkillDefinition, paths: TargetPaths): SkillArtifact[] {
  const workspace = paths.workspaceRoot;
  switch (id) {
    case 'codex':
      return [{ path: join(paths.homeDir, '.codex', 'prompts', `${skill.name}.md`), scope: 'global', kind: 'legacy-file' }];
    case 'gemini':
      return [
        { path: join(paths.homeDir, '.gemini', 'commands', `${skill.name}.toml`), scope: 'global', kind: 'legacy-file' },
        ...(workspace
          ? [{ path: join(workspace, '.gemini', 'commands', `${skill.name}.toml`), scope: 'project' as const, kind: 'legacy-file' as const }]
          : []),
      ];
    case 'antigravity':
      return [{ path: join(paths.homeDir, '.gemini', 'GEMINI.md'), scope: 'global', kind: 'legacy-block' }];
    case 'copilot':
      return workspace
        ? [{ path: join(workspace, '.github', 'copilot-instructions.md'), scope: 'project', kind: 'legacy-block' }]
        : [];
    default:
      return [];
  }
}

/**
 * Every file the skill may live in for this target, native and legacy. Pass a
 * `scope` to narrow it; omit it to sweep both, which is what an uninstall has
 * to do.
 */
export function skillArtifacts(
  id: SkillTargetId,
  skill: SkillDefinition,
  paths: TargetPaths,
  scope?: McpScope,
): SkillArtifact[] {
  const artifacts = [
    nativeArtifact(id, skill, paths, 'global'),
    nativeArtifact(id, skill, paths, 'project'),
    ...legacyArtifacts(id, skill, paths),
  ].filter((artifact): artifact is SkillArtifact => artifact !== undefined);
  return scope ? artifacts.filter((artifact) => artifact.scope === scope) : artifacts;
}

// ----------------------------------------------------------------- rendering

/**
 * The exact bytes this target's `SKILL.md` should hold.
 *
 * Claude Code gets the file untouched — `argument-hint` and `user-invocable`
 * are its own fields. The others get only the two fields the open standard
 * requires: a loader strict about its schema (Codex, Gemini) must never skip
 * the skill over a key it does not know.
 */
export function renderSkill(id: SkillTargetId, skill: SkillDefinition): string {
  if (id === 'claude') return `${skill.source}\n`;
  return `---\nname: ${skill.name}\ndescription: ${yamlString(skill.description)}\n---\n\n${skill.body}\n`;
}

/** A YAML scalar that survives colons, quotes and a leading special character. */
function yamlString(value: string): string {
  return /^[\w(][^:#\n]*$/.test(value) && !/^(true|false|null|yes|no|~)$/i.test(value)
    ? value
    : JSON.stringify(value);
}

// ------------------------------------------------------------------ install

export function installSkill(
  skill: SkillDefinition,
  id: SkillTargetId,
  paths: TargetPaths,
  scope: McpScope,
): SkillWriteResult {
  const displayName = DISPLAY_NAMES[id];
  const artifact = nativeArtifact(id, skill, paths, scope);
  if (!artifact) {
    return {
      target: id,
      displayName,
      scope,
      action: 'skipped',
      reason: `${displayName} stores this inside the workspace, and no folder is open.`,
    };
  }

  const content = renderSkill(id, skill);
  const existed = existsSync(artifact.path);
  let action: WriteAction;
  if (existed && readTextFile(artifact.path) === content) {
    action = 'unchanged';
  } else {
    writeTextFileAtomic(artifact.path, content);
    action = existed ? 'updated' : 'created';
  }

  // The native skill now covers this scope, so an older copy would only make
  // the agent read the same guidance twice.
  const migrated = legacyArtifacts(id, skill, paths)
    .filter((legacy) => legacy.scope === scope)
    .filter((legacy) => removeArtifact(legacy));
  if (migrated.length > 0 && action === 'unchanged') action = 'updated';

  return {
    target: id,
    displayName,
    scope,
    action,
    path: artifact.path,
    ...(migrated.length > 0 ? { migrated: migrated.map((legacy) => legacy.path) } : {}),
  };
}

/** Delete one artifact; true when there was something to delete. */
function removeArtifact(artifact: SkillArtifact): boolean {
  if (!existsSync(artifact.path)) return false;

  if (artifact.kind !== 'legacy-block') {
    // The file is ours end to end, so deleting it is the correct removal.
    rmSync(artifact.path, { force: true });
    if (artifact.kind === 'file') removeIfEmpty(dirname(artifact.path));
    return true;
  }

  const result = removeMarkdownBlock(readTextFile(artifact.path), SKILL_BLOCK_START, SKILL_BLOCK_END);
  if (result.action !== 'removed') return false;
  // The rest of the file is the user's, so an emptied instructions file is
  // left in place rather than deleted.
  writeTextFileAtomic(artifact.path, result.content);
  return true;
}

/** The skill's own folder, once its `SKILL.md` is gone — never anything above it. */
function removeIfEmpty(directory: string): void {
  try {
    rmdirSync(directory);
  } catch {
    // Not empty (the user put something there) or already gone.
  }
}

/**
 * Remove the skill, native and legacy. With no `scope` this sweeps both, so
 * an uninstall leaves nothing behind at the scope the user is not looking at.
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

  const touched = artifacts.filter((artifact) => removeArtifact(artifact)).map((artifact) => artifact.path);
  return {
    target: id,
    displayName,
    action: touched.length > 0 ? 'removed' : 'not-found',
    paths: touched.length > 0 ? touched : artifacts.map((artifact) => artifact.path),
  };
}

/**
 * The artifacts that currently hold this skill, across both scopes and both
 * formats.
 *
 * Used to refresh after an extension update: the skill text ships with the
 * extension, so a new version leaves every installed copy out of date, and a
 * legacy copy is out of date by definition. Only scopes where the user
 * already installed the skill are ever written — this never installs it
 * behind their back.
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

    if (artifact.kind !== 'legacy-block') {
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
  if (installed.artifact.kind !== 'file') return true;
  return installed.content !== renderSkill(id, skill);
}

/**
 * The (skill, scope) installs that bring one agent in line with this build.
 *
 * `skills[0]` is the base skill. Wherever the user already has it, every other
 * shipped skill is installed too: they opted into CodeBrain's skills for that
 * agent at that scope, and a workflow skill added in a later release is part of
 * the same package, not a new decision. Stale copies of any skill are
 * rewritten. An agent without the base skill is left alone entirely.
 */
export function planSkillRefresh(
  skills: readonly SkillDefinition[],
  id: SkillTargetId,
  paths: TargetPaths,
): { skill: SkillDefinition; scope: McpScope }[] {
  const base = skills[0];
  if (!base) return [];
  const baseScopes = new Set(readInstalledSkills(base, id, paths).map((entry) => entry.artifact.scope));

  const plan: { skill: SkillDefinition; scope: McpScope }[] = [];
  for (const skill of skills) {
    const installed = readInstalledSkills(skill, id, paths);
    const scopes = new Set(
      installed.filter((entry) => isSkillStale(entry, skill, id)).map((entry) => entry.artifact.scope),
    );
    if (skill !== base) {
      const present = new Set(
        installed.filter((entry) => entry.artifact.kind === 'file').map((entry) => entry.artifact.scope),
      );
      for (const scope of baseScopes) if (!present.has(scope)) scopes.add(scope);
    }
    for (const scope of scopes) plan.push({ skill, scope });
  }
  return plan;
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
