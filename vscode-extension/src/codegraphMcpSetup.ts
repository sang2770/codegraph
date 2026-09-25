/**
 * Exposing the code graph MCP server — and the CodeBrain skills — to
 * agents other than Copilot.
 *
 * Copilot receives both from the extension itself: the server as a definition
 * from `src/mcpProvider.ts`, the skill from `contributes.chatSkills`. Both are
 * VS Code-only channels, so Claude Code, Codex CLI, Gemini CLI, Antigravity,
 * Copilot CLI, Cursor and opencode never see either one. They each read their
 * own files instead, so this installs the same npm-managed runtime and the same
 * skill text there, through the shared writers in `src/agents/`.
 *
 * The MCP entry carries no `--path`: every one of these agents launches its
 * servers from the directory the user is working in, and the server resolves
 * the nearest `.codegraph/` from that cwd. Pinning a workspace here would break
 * the user-scoped agents the moment the user opened a second repository.
 */

import { subagentExtra } from './agents/extras';
import { McpServerEntry } from './agents/mcpTargets';
import { McpRegistrar } from './agents/registration';
import { SkillDefinition, loadSkills } from './agents/skillTargets';
import { loadSubagents, SubagentDefinition } from './agents/subagentTargets';
import { codeBrainEnvironment, CodeBrainRuntime, requireRuntime } from './runtime';

/** The key the code graph server is registered under in every agent config. */
export const CODEBRAIN_MCP_KEY = 'codebrain';

export class CodeBrainMcpRegistration {
  private readonly registrar: McpRegistrar;
  private skills: SkillDefinition[] | undefined;
  private subagents: SubagentDefinition[] | undefined;

  constructor(
    private readonly runtime: CodeBrainRuntime,
    private readonly extensionPath: string,
    private readonly log: (message: string) => void,
  ) {
    this.registrar = new McpRegistrar({
      serverKey: CODEBRAIN_MCP_KEY,
      label: 'CodeBrain',
      entry: () => this.serverEntry(),
      skills: () => this.skillDefinitions(),
      extras: [subagentExtra(() => this.subagentDefinitions())],
      log: (message) => log(`[agents] ${message}`),
    });
  }

  /**
   * The command every agent runs. The runtime's own vendored Node is used
   * rather than a `node` on PATH: GUI-launched agents get a stripped PATH, and
   * this one is guaranteed present and version-correct.
   */
  serverEntry(): McpServerEntry {
    const runtime = requireRuntime(this.runtime);
    return {
      command: runtime.command,
      args: [...runtime.baseArgs, 'serve', '--mcp'],
      env: codeBrainEnvironment(),
    };
  }

  /**
   * The skills shipped with the extension — the same files Copilot is given,
   * so every agent is told the same thing: the general tool guidance plus the
   * explain / implement / fix / review workflows. Parsed once and cached: they
   * cannot change without the extension itself being replaced.
   */
  private skillDefinitions(): SkillDefinition[] {
    if (!this.skills) this.skills = loadSkills(this.extensionPath);
    return this.skills;
  }

  /** The Dev and Reviewer roles, from the same files Copilot's custom agents use. */
  private subagentDefinitions(): SubagentDefinition[] {
    if (!this.subagents) this.subagents = loadSubagents(this.extensionPath);
    return this.subagents;
  }

  /** The installer for this server's MCP entry, skills and subagents. */
  get agents(): McpRegistrar {
    return this.registrar;
  }

  /**
   * Repair what an update left stale — entries pointing at the previous
   * runtime version's path, and skill copies from an older extension's text.
   * Best-effort: a missing or unreadable skill file must not break activation.
   * Waits for the runtime when it is still being installed.
   */
  refreshInstalledTargets(): void {
    if (!this.runtime.current()) return;
    try {
      this.registrar.refreshInstalledTargets();
    } catch (error) {
      this.log(
        `[agents] refresh failed — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
