/**
 * Everything one extension-hosted MCP server installs into agents outside VS
 * Code — its MCP entry, its skills, its extras (subagents, hooks) — as three
 * prompt-free operations: install for chosen agents, remove everywhere, and
 * the post-upgrade repair pass.
 *
 * `mcpTargets.ts`, `skillTargets.ts` and the extras own the file writes; the
 * one dialog the user sees lives in `setup.ts`, which drives the code graph
 * server and the Atlassian server together.
 */

import { homedir } from 'node:os';
import {
  AGENT_TARGET_IDS,
  McpScope,
  McpServerEntry,
  TargetPaths,
  describeTargets,
  installTarget,
  isEntryStale,
  readInstalledEntries,
  removeTarget,
  targetDisplayName,
  targetEntry,
} from './mcpTargets';
import {
  SKILL_TARGET_IDS,
  SkillDefinition,
  SkillTargetId,
  describeSkillTargets,
  installSkill,
  planSkillRefresh,
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
  /** The skills to install alongside the server, when this server has any. */
  skills?: () => readonly SkillDefinition[];
  /**
   * Further artifacts offered next to the server and skills — subagents, a
   * prompt hook — each supported by only some agents.
   */
  extras?: readonly RegistrarExtra[];
  log: (message: string) => void;
}

/**
 * One optional artifact the registrar can install, remove and refresh for the
 * agents that support it. Keeps agent-specific extras (Claude Code's hooks and
 * subagents, opencode's agents) out of the shared install workflow.
 */
export interface RegistrarExtra {
  id: string;
  /** Quick-pick label, with its codicon. */
  label: string;
  detail: string;
  targets: readonly SkillTargetId[];
  /** Where this lands for one agent at one scope, shown in the agent picker. */
  describe(target: SkillTargetId, scope: McpScope): string;
  install(
    target: SkillTargetId,
    paths: TargetPaths,
    scope: McpScope,
  ): { displayName: string; action: string; path?: string; reason?: string };
  remove(target: SkillTargetId, paths: TargetPaths): { action: 'removed' | 'not-found'; paths: string[] };
  /** Bring copies the user already has in line with this build; returns log lines. */
  refresh(target: SkillTargetId, paths: TargetPaths): string[];
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
   * The agents this server can be installed for at `scope`, each with the files
   * it would get — the MCP entry, the skills, and any extras that agent takes.
   */
  offeredTargets(scope: McpScope): { id: SkillTargetId; label: string; details: string[] }[] {
    const mcp = new Map(
      describeTargets(this.options.serverKey, scope).map((target) => [target.id, target]),
    );
    const skills = this.options.skills?.() ?? [];
    const skillTargets = new Map(
      skills[0] ? describeSkillTargets(skills[0], scope).map((target) => [target.id, target]) : [],
    );
    const more = skills.length > 1 ? ` (+${skills.length - 1} workflow skills)` : '';

    const offered: { id: SkillTargetId; label: string; details: string[] }[] = [];
    for (const id of SKILL_TARGET_IDS) {
      const details: string[] = [];
      const server = mcp.get(id);
      if (server?.supported) details.push(`${this.options.label} MCP: ${server.detail}`);
      if (skillTargets.get(id)?.supported) details.push(`Skills: ${skillTargets.get(id)!.detail}${more}`);
      for (const extra of this.options.extras ?? []) {
        if (extra.targets.includes(id)) {
          details.push(`${extra.label.replace(/^\$\([^)]*\)\s*/, '')}: ${extra.describe(id, scope)}`);
        }
      }
      if (details.length > 0) offered.push({ id, label: skillTargetDisplayName(id), details });
    }
    return offered;
  }

  /**
   * Install everything this server offers — MCP entry, skills, extras — for the
   * given agents at one scope. No prompts: the caller already asked.
   */
  installAll(ids: readonly SkillTargetId[], scope: McpScope): { succeeded: string[]; skipped: string[] } {
    const { serverKey, label } = this.options;
    const paths = this.targetPaths();
    const entry = this.options.entry();
    const skills = this.options.skills?.() ?? [];
    const succeeded: string[] = [];
    const skipped: string[] = [];

    const attempt = (
      id: SkillTargetId,
      what: string,
      run: () => { displayName: string; action: string; path?: string; reason?: string; migrated?: string[] },
    ): void => {
      try {
        const result = run();
        this.options.log(
          `${result.displayName} ${what} (${scope}): ${result.action}${result.path ? ` (${result.path})` : ''}${result.reason ? ` — ${result.reason}` : ''}${result.migrated ? ` — replaced ${result.migrated.join(', ')}` : ''}`,
        );
        if (result.action === 'skipped') {
          skipped.push(`${result.displayName} ${what} — ${result.reason ?? 'not applicable'}`);
        } else {
          succeeded.push(`${result.displayName} ${what}`);
        }
      } catch (error) {
        skipped.push(`${skillTargetDisplayName(id)} ${what} — ${describeError(error)}`);
        this.options.log(`${skillTargetDisplayName(id)} ${what}: failed — ${describeError(error)}`);
      }
    };

    for (const id of ids) {
      if (AGENT_TARGET_IDS.includes(id)) {
        attempt(id, `${label} MCP`, () => installTarget(serverKey, id, entry, paths, scope));
      }
      for (const skill of skills) {
        attempt(id, `skill ${skill.name}`, () => installSkill(skill, id, paths, scope));
      }
      for (const extra of this.options.extras ?? []) {
        if (extra.targets.includes(id)) attempt(id, extra.id, () => extra.install(id, paths, scope));
      }
    }
    return { succeeded, skipped };
  }

  /**
   * Remove the server entry, the skills and the extras from every agent that
   * holds them. Both scopes are swept without asking: an uninstall that left a
   * forgotten copy behind at the other scope would look like it had failed.
   */
  removeAll(): string[] {
    const { serverKey, label } = this.options;
    const paths = this.targetPaths();
    const skills = this.options.skills?.() ?? [];
    const removed: string[] = [];

    for (const id of AGENT_TARGET_IDS) {
      try {
        const result = removeTarget(serverKey, id, paths);
        this.options.log(`${result.displayName} MCP: ${result.action} (${result.paths.join(', ')})`);
        if (result.action === 'removed') removed.push(`${result.displayName} (${label} MCP)`);
      } catch (error) {
        this.options.log(`${targetDisplayName(id)} MCP: remove failed — ${describeError(error)}`);
      }
    }

    for (const id of SKILL_TARGET_IDS) {
      let removedAny = false;
      for (const skill of skills) {
        try {
          const result = removeSkill(skill, id, paths);
          this.options.log(
            `${result.displayName} skill ${skill.name}: ${result.action} (${result.paths.join(', ')})`,
          );
          if (result.action === 'removed') removedAny = true;
        } catch (error) {
          this.options.log(
            `${skillTargetDisplayName(id)} skill ${skill.name}: remove failed — ${describeError(error)}`,
          );
        }
      }
      if (removedAny) removed.push(`${skillTargetDisplayName(id)} (skills)`);
    }

    for (const extra of this.options.extras ?? []) {
      for (const id of extra.targets) {
        try {
          const result = extra.remove(id, paths);
          this.options.log(`${skillTargetDisplayName(id)} ${extra.id}: ${result.action} (${result.paths.join(', ')})`);
          if (result.action === 'removed') removed.push(`${skillTargetDisplayName(id)} (${extra.id})`);
        } catch (error) {
          this.options.log(`${skillTargetDisplayName(id)} ${extra.id}: remove failed — ${describeError(error)}`);
        }
      }
    }
    return removed;
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
    const skills = this.options.skills?.() ?? [];

    for (const extra of this.options.extras ?? []) {
      for (const id of extra.targets) {
        try {
          for (const line of extra.refresh(id, paths)) this.options.log(line);
        } catch (error) {
          this.options.log(`${skillTargetDisplayName(id)} ${extra.id}: refresh failed — ${describeError(error)}`);
        }
      }
    }

    for (const id of AGENT_TARGET_IDS) {
      const displayName = targetDisplayName(id);
      let installed: ReturnType<typeof readInstalledEntries>;
      try {
        installed = readInstalledEntries(serverKey, id, paths);
      } catch (error) {
        this.options.log(`${displayName}: could not read config — ${describeError(error)}`);
        continue;
      }

      const stale = installed.filter((found) =>
        isEntryStale(found.entry, targetEntry(id, entry, paths, found.file.scope)),
      );
      for (const { file } of stale) {
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

    for (const id of SKILL_TARGET_IDS) {
      const displayName = skillTargetDisplayName(id);
      let plan: ReturnType<typeof planSkillRefresh>;
      try {
        plan = planSkillRefresh(skills, id, paths);
      } catch (error) {
        this.options.log(`${displayName}: could not read skills — ${describeError(error)}`);
        continue;
      }
      // One install per skill and scope: it rewrites the native copy and clears
      // any legacy one at the same time.
      for (const { skill, scope } of plan) {
        try {
          const result = installSkill(skill, id, paths, scope);
          this.options.log(
            `${result.displayName} skill ${skill.name} (${scope}): refreshed (${result.action})${result.migrated ? ` — replaced ${result.migrated.join(', ')}` : ''}`,
          );
        } catch (error) {
          this.options.log(
            `${displayName} skill ${skill.name} (${scope}): refresh failed — ${describeError(error)}`,
          );
        }
      }
    }
  }
}


function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
