/**
 * The single "set up agents" flow: one scope question, one agent list, and
 * everything CodeBrain offers written for the agents picked — the code graph
 * MCP server with its skills and subagents, plus the Atlassian server with its
 * ticket hook when Jira or Confluence is configured.
 *
 * It replaces a pair of install commands per server and a "which parts?"
 * question: nearly everyone wanted all of it, and the separate commands made
 * the Atlassian half easy to miss.
 */

import * as vscode from 'vscode';
import { McpScope } from './mcpTargets';
import { McpRegistrar } from './registration';
import { SkillTargetId } from './skillTargets';
import { getWorkspaceFolder } from '../workspace';

export interface SetupSources {
  codeBrain: McpRegistrar;
  atlassian: McpRegistrar;
  /** Makes sure the runtime the entries point at exists. False to abort. */
  prepare(): Promise<boolean>;
  atlassianConfigured(): Promise<boolean>;
}

/** Ask where; skipped with no folder open, where only global makes sense. */
async function chooseScope(): Promise<McpScope | undefined> {
  if (!getWorkspaceFolder()) return 'global';
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: '$(globe) Global',
        description: 'every project on this machine',
        detail: 'Written to your home directory. One setup covers every repository you open.',
        scope: 'global' as const,
      },
      {
        label: '$(folder) This workspace only',
        description: 'travels with the repository',
        detail: 'Written inside the workspace. Some agents only support global setup.',
        scope: 'project' as const,
      },
    ],
    { title: 'CodeBrain: set up agents — where?', placeHolder: 'Pick a scope' },
  );
  return pick?.scope;
}

export async function setUpAgents(sources: SetupSources): Promise<void> {
  if (!(await sources.prepare())) return;
  const scope = await chooseScope();
  if (!scope) return;

  const withAtlassian = await sources.atlassianConfigured();
  const registrars = withAtlassian ? [sources.codeBrain, sources.atlassian] : [sources.codeBrain];

  // One row per agent, listing everything each server would write for it.
  const rows = new Map<SkillTargetId, { label: string; details: string[] }>();
  for (const registrar of registrars) {
    for (const target of registrar.offeredTargets(scope)) {
      const row = rows.get(target.id) ?? { label: target.label, details: [] };
      row.details.push(...target.details);
      rows.set(target.id, row);
    }
  }
  if (rows.size === 0) {
    void vscode.window.showWarningMessage('CodeBrain: no supported agent can be set up at this scope.');
    return;
  }

  const picks = await vscode.window.showQuickPick(
    [...rows].map(([id, row]) => ({ id, label: row.label, detail: row.details.join('  ·  '), picked: true })),
    {
      canPickMany: true,
      title: 'CodeBrain: set up agents — which ones?',
      placeHolder: withAtlassian
        ? 'Code graph + Jira/Confluence tools, skills, subagents and hook. Copilot in VS Code is already set up.'
        : 'Code graph tools, skills and subagents. Configure Atlassian first to add Jira/Confluence. Copilot in VS Code is already set up.',
    },
  );
  if (!picks || picks.length === 0) return;

  const ids = picks.map((pick) => pick.id);
  const skipped: string[] = [];
  let wrote = 0;
  for (const registrar of registrars) {
    const result = registrar.installAll(ids, scope);
    wrote += result.succeeded.length;
    skipped.push(...result.skipped);
  }

  if (wrote > 0) {
    const names = picks.map((pick) => pick.label).join(', ');
    const action = withAtlassian ? undefined : 'Configure Atlassian';
    const choice = await vscode.window.showInformationMessage(
      `CodeBrain is set up for ${names}. Restart the agent to pick it up.${withAtlassian ? '' : ' Add Jira/Confluence context by configuring Atlassian, then run this again.'}`,
      ...(action ? [action] : []),
    );
    if (choice === 'Configure Atlassian') await vscode.commands.executeCommand('codebrain.configureAtlassian');
  }
  if (skipped.length > 0) {
    void vscode.window.showWarningMessage(`CodeBrain skipped: ${skipped.join('; ')}.`);
  }
}

export function removeFromAgents(sources: Pick<SetupSources, 'codeBrain' | 'atlassian'>): void {
  const removed = [...sources.codeBrain.removeAll(), ...sources.atlassian.removeAll()];
  void vscode.window.showInformationMessage(
    removed.length > 0
      ? `CodeBrain removed from ${[...new Set(removed.map((entry) => entry.replace(/\s*\(.*\)$/, '')))].join(', ')}.`
      : 'CodeBrain was not set up for any agent outside VS Code.',
  );
}
