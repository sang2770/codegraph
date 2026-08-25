/**
 * The user-facing half of registering an extension-hosted MCP server — and the
 * CodeBrain skill — with agents outside VS Code: the scope choice, the agent
 * picker, the result notifications, and the post-upgrade repair pass.
 *
 * `mcpTargets.ts` and `skillTargets.ts` own the file writes; this owns the
 * workflow around them, so the code graph server and the Atlassian server
 * behave identically instead of each growing its own dialog copy. A server with
 * no skill (Atlassian) simply omits `skill` and never sees that half of the
 * flow.
 */

import { homedir } from 'node:os';
import * as vscode from 'vscode';
import {
  AGENT_TARGET_IDS,
  AgentTargetId,
  McpScope,
  McpServerEntry,
  TargetPaths,
  describeTargets,
  installTarget,
  isEntryStale,
  readInstalledEntries,
  removeTarget,
  targetDisplayName,
} from './mcpTargets';
import {
  SKILL_TARGET_IDS,
  SkillDefinition,
  SkillTargetId,
  describeSkillTargets,
  installSkill,
  isSkillStale,
  readInstalledSkills,
  removeSkill,
  skillTargetDisplayName,
} from './skillTargets';
import { getWorkspaceFolder } from '../workspace';

export interface McpRegistrarOptions {
  /** The key the server is registered under in every agent config. */
  serverKey: string;
  /** How the server is named in dialogs, e.g. `CodeBrain`. */
  label: string;
  /** Built fresh per call: the runtime path changes with every update. */
  entry: () => McpServerEntry;
  /**
   * The skill to install alongside the server, when this server has one.
   * Omitted servers keep the MCP-only flow, with no extra prompt.
   */
  skill?: () => SkillDefinition;
  log: (message: string) => void;
}

/** What the user chose to install in this run. */
interface Parts {
  mcp: boolean;
  skill: boolean;
}

export class McpRegistrar {
  constructor(private readonly options: McpRegistrarOptions) {}

  private targetPaths(): TargetPaths {
    return {
      homeDir: homedir(),
      workspaceRoot: getWorkspaceFolder()?.uri.fsPath,
    };
  }

  /**
   * Ask where the entry should live.
   *
   * Skipped entirely with no folder open: project scope has nowhere to write,
   * so there is nothing to choose between.
   */
  private async chooseScope(): Promise<McpScope | undefined> {
    if (!getWorkspaceFolder()) return 'global';

    const pick = await vscode.window.showQuickPick(
      [
        {
          label: '$(globe) Global',
          description: 'every project on this machine',
          detail:
            'Written to your home directory. One registration covers every repository you open.',
          scope: 'global' as const,
        },
        {
          label: '$(folder) This workspace only',
          description: 'travels with the repository',
          detail:
            'Written inside the workspace. Some agents have no project-scoped config and are only offered globally.',
          scope: 'project' as const,
        },
      ],
      {
        title: `CodeBrain: where should ${this.options.label} be registered?`,
        placeHolder: 'Pick a scope',
      },
    );
    return pick?.scope;
  }

  /** Ask whether to install the server, the skill, or both. */
  private async chooseParts(): Promise<Parts | undefined> {
    if (!this.options.skill) return { mcp: true, skill: false };

    const picks = await vscode.window.showQuickPick(
      [
        {
          label: '$(plug) MCP server',
          detail: 'Gives the agent CodeBrain’s graph tools.',
          part: 'mcp' as const,
          picked: true,
        },
        {
          label: '$(book) Skill',
          detail: 'Tells the agent when and how to use those tools.',
          part: 'skill' as const,
          picked: true,
        },
      ],
      {
        canPickMany: true,
        title: `CodeBrain: what should be installed for ${this.options.label}?`,
        placeHolder: 'Both is the usual choice — the tools plus the guidance for using them',
      },
    );
    if (!picks || picks.length === 0) return undefined;

    return {
      mcp: picks.some((pick) => pick.part === 'mcp'),
      skill: picks.some((pick) => pick.part === 'skill'),
    };
  }

  /**
   * The agents worth offering at this scope, with the files each will get.
   *
   * An agent appears when at least one selected part supports it — Copilot has
   * no MCP entry to write but does take the skill, and Codex has neither at
   * project scope.
   */
  private offeredTargets(
    parts: Parts,
    scope: McpScope,
    skill: SkillDefinition | undefined,
  ): { label: string; detail: string; id: SkillTargetId }[] {
    const mcp = new Map(
      describeTargets(this.options.serverKey, scope).map((target) => [target.id, target]),
    );
    const skills = new Map(
      skill ? describeSkillTargets(skill, scope).map((target) => [target.id, target]) : [],
    );

    const offered: { label: string; detail: string; id: SkillTargetId }[] = [];
    for (const id of SKILL_TARGET_IDS) {
      const details: string[] = [];
      if (parts.mcp && mcp.get(id as AgentTargetId)?.supported) {
        details.push(`MCP: ${mcp.get(id as AgentTargetId)!.detail}`);
      }
      if (parts.skill && skills.get(id)?.supported) {
        details.push(`Skill: ${skills.get(id)!.detail}`);
      }
      if (details.length === 0) continue;
      offered.push({ label: skillTargetDisplayName(id), detail: details.join('  ·  '), id });
    }
    return offered;
  }

  /** Ask for a scope, what to install and the agents, then write the files. */
  async install(): Promise<void> {
    const { serverKey, label } = this.options;

    const scope = await this.chooseScope();
    if (!scope) return;

    const parts = await this.chooseParts();
    if (!parts) return;

    const skill = parts.skill ? this.options.skill?.() : undefined;
    const offered = this.offeredTargets(parts, scope, skill);
    if (offered.length === 0) {
      void vscode.window.showWarningMessage(
        `CodeBrain: none of the supported agents can take that at ${scopeName(scope)}.`,
      );
      return;
    }

    const picks = await vscode.window.showQuickPick(
      offered.map((target) => ({ ...target, picked: true })),
      {
        canPickMany: true,
        title: `CodeBrain: install ${label} (${scopeName(scope)})`,
        placeHolder: 'Copilot inside VS Code is already covered by the extension itself',
      },
    );
    if (!picks || picks.length === 0) return;

    const paths = this.targetPaths();
    const entry = parts.mcp ? this.options.entry() : undefined;
    const succeeded: string[] = [];
    const skipped: string[] = [];

    const record = (
      result: { displayName: string; action: string; path?: string; reason?: string },
      what: string,
      scopeLabel: McpScope,
    ): void => {
      this.options.log(
        `${result.displayName} ${what} (${scopeLabel}): ${result.action}${result.path ? ` (${result.path})` : ''}${result.reason ? ` — ${result.reason}` : ''}`,
      );
      if (result.action === 'skipped') {
        skipped.push(`${result.displayName} ${what} — ${result.reason ?? 'not applicable'}`);
      } else {
        succeeded.push(`${result.displayName} ${what} (${result.action})`);
      }
    };

    for (const pick of picks) {
      if (entry && AGENT_TARGET_IDS.includes(pick.id as AgentTargetId)) {
        try {
          record(
            installTarget(serverKey, pick.id as AgentTargetId, entry, paths, scope),
            'MCP',
            scope,
          );
        } catch (error) {
          skipped.push(`${pick.label} MCP — ${describeError(error)}`);
          this.options.log(`${pick.label} MCP: failed — ${describeError(error)}`);
        }
      }
      if (skill) {
        try {
          record(installSkill(skill, pick.id, paths, scope), 'skill', scope);
        } catch (error) {
          skipped.push(`${pick.label} skill — ${describeError(error)}`);
          this.options.log(`${pick.label} skill: failed — ${describeError(error)}`);
        }
      }
    }

    if (succeeded.length > 0) {
      void vscode.window.showInformationMessage(
        `${label} installed ${scopeName(scope)}: ${succeeded.join(', ')}. Restart the agent to pick it up.`,
      );
    }
    if (skipped.length > 0) {
      void vscode.window.showWarningMessage(
        `CodeBrain could not install ${label}: ${skipped.join('; ')}.`,
      );
    }
  }

  /**
   * Remove the server entry and the skill from every agent config that holds
   * one.
   *
   * Both scopes are swept without asking: an uninstall that left a forgotten
   * copy behind at the other scope would look like it had failed.
   */
  async remove(): Promise<void> {
    const { serverKey, label } = this.options;
    const paths = this.targetPaths();
    const skill = this.options.skill?.();
    const removed: string[] = [];

    for (const id of AGENT_TARGET_IDS) {
      try {
        const result = removeTarget(serverKey, id, paths);
        this.options.log(`${result.displayName} MCP: ${result.action} (${result.paths.join(', ')})`);
        if (result.action === 'removed') removed.push(`${result.displayName} (MCP)`);
      } catch (error) {
        this.options.log(`${targetDisplayName(id)} MCP: remove failed — ${describeError(error)}`);
      }
    }

    if (skill) {
      for (const id of SKILL_TARGET_IDS) {
        try {
          const result = removeSkill(skill, id, paths);
          this.options.log(
            `${result.displayName} skill: ${result.action} (${result.paths.join(', ')})`,
          );
          if (result.action === 'removed') removed.push(`${result.displayName} (skill)`);
        } catch (error) {
          this.options.log(
            `${skillTargetDisplayName(id)} skill: remove failed — ${describeError(error)}`,
          );
        }
      }
    }

    void vscode.window.showInformationMessage(
      removed.length > 0
        ? `${label} removed from ${removed.join(', ')}.`
        : `${label} was not installed for any agent outside VS Code.`,
    );
  }

  /**
   * Bring config entries and skill copies that already exist back in line with
   * this build.
   *
   * The MCP entry embeds the extension's install directory, which carries the
   * version number, and the skill text ships with the extension — so every
   * update silently leaves both stale. Both scopes are repaired, only agents
   * that already opted in are touched, and anything already correct is left
   * alone.
   */
  refreshInstalledTargets(): void {
    const { serverKey } = this.options;
    const paths = this.targetPaths();
    const entry = this.options.entry();
    const skill = this.options.skill?.();

    for (const id of AGENT_TARGET_IDS) {
      const displayName = targetDisplayName(id);
      let installed: ReturnType<typeof readInstalledEntries>;
      try {
        installed = readInstalledEntries(serverKey, id, paths);
      } catch (error) {
        this.options.log(`${displayName}: could not read config — ${describeError(error)}`);
        continue;
      }

      for (const { file } of installed.filter((found) => isEntryStale(found.entry, entry))) {
        try {
          const result = installTarget(serverKey, id, entry, paths, file.scope);
          this.options.log(
            `${result.displayName} MCP (${file.scope}): refreshed stale server path (${result.action})`,
          );
        } catch (error) {
          this.options.log(
            `${displayName} MCP (${file.scope}): refresh failed — ${describeError(error)}`,
          );
        }
      }
    }

    if (!skill) return;

    for (const id of SKILL_TARGET_IDS) {
      const displayName = skillTargetDisplayName(id);
      let installed: ReturnType<typeof readInstalledSkills>;
      try {
        installed = readInstalledSkills(skill, id, paths);
      } catch (error) {
        this.options.log(`${displayName}: could not read skill — ${describeError(error)}`);
        continue;
      }

      for (const found of installed.filter((entry) => isSkillStale(entry, skill, id))) {
        try {
          const result = installSkill(skill, id, paths, found.artifact.scope);
          this.options.log(
            `${result.displayName} skill (${found.artifact.scope}): refreshed (${result.action})`,
          );
        } catch (error) {
          this.options.log(
            `${displayName} skill (${found.artifact.scope}): refresh failed — ${describeError(error)}`,
          );
        }
      }
    }
  }
}

function scopeName(scope: McpScope): string {
  return scope === 'global' ? 'globally' : 'for this workspace';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
