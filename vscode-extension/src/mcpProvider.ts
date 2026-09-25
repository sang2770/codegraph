import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { AtlassianIntegration } from './atlassianSetup';
import { codeBrainEnvironment } from './runtime';
import { RuntimeManager } from './runtimeManager';
import { getWorkspaceFolder } from './workspace';

const PROVIDER_ID = 'codebrain.runtime';

export function registerMcpProvider(
  context: vscode.ExtensionContext,
  runtime: RuntimeManager,
  atlassian: AtlassianIntegration,
): void {
  const didChange = new vscode.EventEmitter<void>();
  context.subscriptions.push(didChange);

  const extensionVersion = String(context.extension.packageJSON.version);

  const provider: vscode.McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: didChange.event,
    provideMcpServerDefinitions: async () => {
      // Waits out the first install; a failed one leaves no servers to offer
      // until the next attempt succeeds and fires a change.
      let command;
      try {
        command = await runtime.resolve();
      } catch {
        return [];
      }
      const workspaceFolder = getWorkspaceFolder();
      const args = [...command.baseArgs, 'serve', '--mcp'];
      const env = codeBrainEnvironment();
      const codeBrain = new vscode.McpStdioServerDefinition(
        'CodeBrain',
        command.command,
        args,
        env,
        definitionVersion(extensionVersion, command.command, args, env),
      );
      codeBrain.cwd = workspaceFolder?.uri;

      // The Atlassian server is only offered once a product is actually
      // configured: a server that can answer nothing but "not configured" is
      // noise in the MCP list, and an agent that calls it and gets nothing back
      // stops trusting the rest of the tools too.
      if (!(await atlassian.isConfigured())) return [codeBrain];

      const atlassianArgs = [atlassian.serverScriptPath()];
      const atlassianEnv = await atlassian.serverEnvironment();
      const atlassianServer = new vscode.McpStdioServerDefinition(
        'CodeBrain Atlassian',
        command.command,
        atlassianArgs,
        atlassianEnv,
        definitionVersion(extensionVersion, command.command, atlassianArgs, atlassianEnv),
      );
      atlassianServer.cwd = workspaceFolder?.uri;
      return [codeBrain, atlassianServer];
    },
    resolveMcpServerDefinition: (server) => server,
  };

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider),
    // Credentials moved, or a URL changed: the Atlassian definition's env is
    // baked in at provide time, so VS Code has to ask for it again.
    atlassian.onDidChange(() => didChange.fire()),
    runtime.onDidChange(() => didChange.fire()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('codebrain.autoRefresh.enabled') ||
        event.affectsConfiguration('codebrain.autoRefresh.debounceMs') ||
        event.affectsConfiguration('codebrain.mcp.reviewTool')
      ) {
        didChange.fire();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => didChange.fire()),
  );
}

/**
 * The definition's `version`, which is what VS Code keys its server lifetime
 * and cached tool list on: while it stays the same, VS Code keeps the running
 * server and the tools it listed last time. So it has to change whenever what
 * the server offers changes — a runtime update (the command path carries the
 * version), a new tool surface in `env` (the review tool), a setting.
 *
 * Token values are left out of the fingerprint: a credential change still
 * changes it (the key set and the URLs do not, but the Atlassian provider
 * fires a change of its own), and nothing derived from a secret ends up in a
 * string VS Code persists.
 */
export function definitionVersion(
  extensionVersion: string,
  command: string,
  args: readonly string[],
  env: Record<string, string | number | null>,
): string {
  const visibleEnv = Object.keys(env)
    .sort()
    .map((key) => `${key}=${/TOKEN|SECRET|PASSWORD/i.test(key) ? '<redacted>' : String(env[key])}`);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([command, args, visibleEnv]))
    .digest('hex')
    .slice(0, 10);
  return `${extensionVersion}+${fingerprint}`;
}
