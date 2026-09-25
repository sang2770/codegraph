/**
 * Installing CodeBrain's agent roles — Dev and Reviewer — as native subagents
 * of agents outside VS Code.
 *
 * Copilot gets them from `contributes.chatAgents` (`agents/*.agent.md`). The
 * same files are the source here: their body is host-neutral, and only the
 * frontmatter is re-rendered in each host's own schema:
 *
 *   | Agent       | Global                                   | Project                           |
 *   |-------------|------------------------------------------|-----------------------------------|
 *   | Claude Code | `~/.claude/agents/<n>.md`                | `<ws>/.claude/agents/<n>.md`      |
 *   | opencode    | `~/.config/opencode/agent/<n>.md`        | `<ws>/.opencode/agent/<n>.md`     |
 *
 * The files are named `codebrain-*.md` and owned by us end to end, like the
 * skills: install writes them, refresh rewrites stale copies where they exist,
 * uninstall deletes them.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { McpScope, TargetPaths, WriteAction } from './mcpTargets';

export type SubagentTargetId = 'claude' | 'opencode';
export const SUBAGENT_TARGET_IDS: readonly SubagentTargetId[] = ['claude', 'opencode'];

export interface SubagentDefinition {
  /** Slug and file name, e.g. `codebrain-dev`. */
  name: string;
  description: string;
  /** Instructions, identical for every host. */
  body: string;
  /** Read-only roles are denied edit/shell tools where the host lets us say so. */
  readOnly: boolean;
}

/** The roles shipped under `agents/`, and whether each may edit. */
export const CODEBRAIN_SUBAGENTS: readonly { file: string; readOnly: boolean }[] = [
  { file: 'codebrain-dev.agent.md', readOnly: false },
  { file: 'codebrain-reviewer.agent.md', readOnly: true },
];

/**
 * Claude Code tool names for the read-only reviewer. The MCP servers are
 * registered as `codebrain` and `codebrain-atlassian`, which is what fixes the
 * `mcp__<server>__<tool>` prefix.
 */
export const CLAUDE_REVIEWER_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'mcp__codebrain__codegraph_explore',
  'mcp__codebrain__codegraph_review',
  'mcp__codebrain-atlassian__codebrain_task_context',
  'mcp__codebrain-atlassian__jira_get_issue',
  'mcp__codebrain-atlassian__jira_search',
  'mcp__codebrain-atlassian__confluence_search',
  'mcp__codebrain-atlassian__confluence_get_page',
];

/** Parse a Copilot `.agent.md` into a host-neutral definition. */
export function parseAgentFile(source: string, fileName: string, readOnly: boolean): SubagentDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  const frontmatter = match?.[1] ?? '';
  const description = /^description:[ \t]*(.*)$/m.exec(frontmatter)?.[1]?.trim().replace(/^["'](.*)["']$/, '$1') ?? '';
  return {
    name: basename(fileName).replace(/\.agent\.md$/, '').replace(/\.md$/, ''),
    description,
    body: (match ? source.slice(match[0].length) : source).trim(),
    readOnly,
  };
}

export function loadSubagents(extensionPath: string): SubagentDefinition[] {
  return CODEBRAIN_SUBAGENTS.map(({ file, readOnly }) =>
    parseAgentFile(readFileSync(join(extensionPath, 'agents', file), 'utf8'), file, readOnly),
  );
}

const ROOTS: Record<SubagentTargetId, { global: string[]; project: string[] }> = {
  claude: { global: ['.claude', 'agents'], project: ['.claude', 'agents'] },
  opencode: { global: ['.config', 'opencode', 'agent'], project: ['.opencode', 'agent'] },
};

const DISPLAY_NAMES: Record<SubagentTargetId, string> = { claude: 'Claude Code', opencode: 'opencode' };

export function subagentPath(
  id: SubagentTargetId,
  agent: SubagentDefinition,
  paths: TargetPaths,
  scope: McpScope,
): string | undefined {
  const base = scope === 'global' ? paths.homeDir : paths.workspaceRoot;
  return base ? join(base, ...ROOTS[id][scope], `${agent.name}.md`) : undefined;
}

export function describeSubagentTarget(id: SubagentTargetId, scope: McpScope): string {
  const root = scope === 'global' ? `~/${ROOTS[id].global.join('/')}` : `<workspace>/${ROOTS[id].project.join('/')}`;
  return `${root}/codebrain-dev.md, codebrain-reviewer.md`;
}

/** A YAML scalar that survives colons, quotes and a leading special character. */
function yamlString(value: string): string {
  return /^[\w(][^:#\n]*$/.test(value) ? value : JSON.stringify(value);
}

/** The exact bytes this host's agent file should hold. */
export function renderSubagent(id: SubagentTargetId, agent: SubagentDefinition): string {
  const lines = ['---'];
  if (id === 'claude') {
    lines.push(`name: ${agent.name}`, `description: ${yamlString(agent.description)}`);
    // No `tools` line means "inherit everything, MCP included" — what Dev needs.
    if (agent.readOnly) lines.push(`tools: ${CLAUDE_REVIEWER_TOOLS.join(', ')}`);
  } else {
    lines.push(`description: ${yamlString(agent.description)}`, 'mode: subagent');
    if (agent.readOnly) lines.push('tools:', '  write: false', '  edit: false', '  bash: false');
  }
  lines.push('---', '', agent.body, '');
  return lines.join('\n');
}

export interface SubagentWriteResult {
  target: SubagentTargetId;
  displayName: string;
  scope: McpScope;
  action: WriteAction;
  paths: string[];
  reason?: string;
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(temp, content, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function readIfExists(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/** Write every role for one host at one scope. Idempotent. */
export function installSubagents(
  agents: readonly SubagentDefinition[],
  id: SubagentTargetId,
  paths: TargetPaths,
  scope: McpScope,
): SubagentWriteResult {
  const displayName = DISPLAY_NAMES[id];
  const written: string[] = [];
  let created = false;
  let updated = false;
  for (const agent of agents) {
    const path = subagentPath(id, agent, paths, scope);
    if (!path) {
      return {
        target: id,
        displayName,
        scope,
        action: 'skipped',
        paths: [],
        reason: `${displayName} keeps project agents in the workspace, and no folder is open.`,
      };
    }
    const content = renderSubagent(id, agent);
    const current = readIfExists(path);
    written.push(path);
    if (current === content) continue;
    writeAtomic(path, content);
    if (current === undefined) created = true;
    else updated = true;
  }
  return {
    target: id,
    displayName,
    scope,
    action: updated ? 'updated' : created ? 'created' : 'unchanged',
    paths: written,
  };
}

/** Delete every role file of ours for one host, at both scopes. */
export function removeSubagents(
  agents: readonly SubagentDefinition[],
  id: SubagentTargetId,
  paths: TargetPaths,
): { target: SubagentTargetId; displayName: string; action: 'removed' | 'not-found'; paths: string[] } {
  const removed: string[] = [];
  for (const scope of ['global', 'project'] as const) {
    for (const agent of agents) {
      const path = subagentPath(id, agent, paths, scope);
      if (path && existsSync(path)) {
        rmSync(path, { force: true });
        removed.push(path);
      }
    }
  }
  return { target: id, displayName: DISPLAY_NAMES[id], action: removed.length > 0 ? 'removed' : 'not-found', paths: removed };
}

/**
 * Scopes where this host already has any CodeBrain role and at least one role
 * is missing or out of date — a role added in a later release joins the ones
 * the user already opted into, like the workflow skills do.
 */
export function staleSubagentScopes(
  agents: readonly SubagentDefinition[],
  id: SubagentTargetId,
  paths: TargetPaths,
): McpScope[] {
  const scopes: McpScope[] = [];
  for (const scope of ['global', 'project'] as const) {
    const states = agents.map((agent) => {
      const path = subagentPath(id, agent, paths, scope);
      return path ? readIfExists(path) : undefined;
    });
    if (states.every((content) => content === undefined)) continue;
    if (states.some((content, index) => content !== renderSubagent(id, agents[index]!))) scopes.push(scope);
  }
  return scopes;
}

export function subagentDisplayName(id: SubagentTargetId): string {
  return DISPLAY_NAMES[id];
}
