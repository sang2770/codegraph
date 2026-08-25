/**
 * Exposing the bundled code graph MCP server — and the CodeBrain skill — to
 * agents other than Copilot.
 *
 * Copilot receives both from the extension itself: the server as a definition
 * from `src/mcpProvider.ts`, the skill from `contributes.chatSkills`. Both are
 * VS Code-only channels, so Claude Code, Codex CLI, Gemini CLI and Antigravity
 * never see either one. They each read their own files instead, so this
 * installs the same bundled runtime and the same skill text there, through the
 * shared writers in `src/agents/`.
 *
 * The MCP entry carries no `--path`: every one of these agents launches its
 * servers from the directory the user is working in, and the server resolves
 * the nearest `.codegraph/` from that cwd. Pinning a workspace here would break
 * the user-scoped agents the moment the user opened a second repository.
 */

import { McpServerEntry } from './agents/mcpTargets';
import { McpRegistrar } from './agents/registration';
import { SkillDefinition, loadSkill } from './agents/skillTargets';
import { codeBrainEnvironment, RuntimeCommand } from './runtime';

/** The key the code graph server is registered under in every agent config. */
export const CODEBRAIN_MCP_KEY = 'codebrain';

export class CodeBrainMcpRegistration {
  private readonly registrar: McpRegistrar;
  private skill: SkillDefinition | undefined;

  constructor(
    private readonly runtime: RuntimeCommand,
    private readonly extensionPath: string,
    private readonly log: (message: string) => void,
  ) {
    this.registrar = new McpRegistrar({
      serverKey: CODEBRAIN_MCP_KEY,
      label: 'CodeBrain',
      entry: () => this.serverEntry(),
      skill: () => this.skillDefinition(),
      log: (message) => log(`[agents] ${message}`),
    });
  }

  /**
   * The command every agent runs. The extension's bundled Node is used rather
   * than a `node` on PATH: GUI-launched agents get a stripped PATH, and this
   * runtime is guaranteed present and version-correct.
   */
  serverEntry(): McpServerEntry {
    return {
      command: this.runtime.command,
      args: [...this.runtime.baseArgs, 'serve', '--mcp'],
      env: codeBrainEnvironment(),
    };
  }

  /**
   * The skill shipped with the extension — the same file Copilot is given, so
   * every agent is told the same thing. Parsed once and cached: it cannot
   * change without the extension itself being replaced.
   */
  private skillDefinition(): SkillDefinition {
    if (!this.skill) this.skill = loadSkill(this.extensionPath);
    return this.skill;
  }

  /** Ask what to install and where, then write the agents' files. */
  install(): Promise<void> {
    return this.registrar.install();
  }

  /** Remove the entry and the skill from every agent that holds them. */
  remove(): Promise<void> {
    return this.registrar.remove();
  }

  /**
   * Repair what an extension update left stale — entries pointing at the
   * previous version's runtime path, and skill copies from the old text.
   * Best-effort: a missing or unreadable skill file must not break activation.
   */
  refreshInstalledTargets(): void {
    try {
      this.registrar.refreshInstalledTargets();
    } catch (error) {
      this.log(
        `[agents] refresh failed — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
