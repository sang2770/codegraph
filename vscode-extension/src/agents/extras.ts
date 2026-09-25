/**
 * The optional artifacts offered next to an MCP server in the install flow:
 * CodeBrain's Dev/Reviewer subagents, and the Claude Code ticket hook.
 */

import { McpServerEntry } from './mcpTargets';
import {
  installPromptHook,
  readInstalledPromptHooks,
  refreshPromptHooks,
  removePromptHook,
} from './promptHookTargets';
import type { RegistrarExtra } from './registration';
import {
  describeSubagentTarget,
  installSubagents,
  removeSubagents,
  staleSubagentScopes,
  SUBAGENT_TARGET_IDS,
  SubagentDefinition,
  SubagentTargetId,
  subagentDisplayName,
} from './subagentTargets';

export function subagentExtra(load: () => readonly SubagentDefinition[]): RegistrarExtra {
  const asTarget = (id: string): SubagentTargetId => id as SubagentTargetId;
  return {
    id: 'subagents',
    label: '$(hubot) Subagents',
    detail: 'CodeBrain Dev (implements and fixes) and CodeBrain Reviewer (read-only) as native agents.',
    targets: SUBAGENT_TARGET_IDS,
    describe: (id, scope) => describeSubagentTarget(asTarget(id), scope),
    install: (id, paths, scope) => {
      const result = installSubagents(load(), asTarget(id), paths, scope);
      return { displayName: result.displayName, action: result.action, path: result.paths.join(', '), reason: result.reason };
    },
    remove: (id, paths) => removeSubagents(load(), asTarget(id), paths),
    refresh: (id, paths) =>
      staleSubagentScopes(load(), asTarget(id), paths).map((scope) => {
        const result = installSubagents(load(), asTarget(id), paths, scope);
        return `${subagentDisplayName(asTarget(id))} subagents (${scope}): refreshed (${result.action})`;
      }),
  };
}

export function promptHookExtra(entry: () => McpServerEntry): RegistrarExtra {
  return {
    id: 'ticket hook',
    label: '$(zap) Ticket hook (Claude Code)',
    detail:
      'When a prompt names a Jira key — or works on the ticket in your branch name — attach the ticket, its acceptance criteria and spec before the agent starts.',
    targets: ['claude'],
    describe: (_id, scope) =>
      `${scope === 'global' ? '~' : '<workspace>'}/.claude/settings.json → UserPromptSubmit`,
    install: (_id, paths, scope) => ({ displayName: 'Claude Code', ...installPromptHook(entry(), paths, scope) }),
    remove: (_id, paths) => removePromptHook(paths),
    refresh: (_id, paths) => {
      if (readInstalledPromptHooks(paths).length === 0) return [];
      return refreshPromptHooks(entry(), paths).map(
        (result) => `Claude Code ticket hook (${result.scope}): refreshed stale path (${result.action})`,
      );
    },
  };
}
