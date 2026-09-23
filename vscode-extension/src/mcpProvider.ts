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
      // The runtime version is part of the definition's version, so VS Code
      // restarts a running server after an update instead of keeping the old
      // binary alive.
      const version = `${extensionVersion}+${runtime.currentVersion() ?? 'local'}`;
      const workspaceFolder = getWorkspaceFolder();
      const codeBrain = new vscode.McpStdioServerDefinition(
        'CodeBrain',
        command.command,
        [...command.baseArgs, 'serve', '--mcp'],
        codeBrainEnvironment(),
        version,
      );
      codeBrain.cwd = workspaceFolder?.uri;

      // The Atlassian server is only offered once a product is actually
      // configured: a server that can answer nothing but "not configured" is
      // noise in the MCP list, and an agent that calls it and gets nothing back
      // stops trusting the rest of the tools too.
      if (!(await atlassian.isConfigured())) return [codeBrain];

      const atlassianServer = new vscode.McpStdioServerDefinition(
        'CodeBrain Atlassian',
        command.command,
        [atlassian.serverScriptPath()],
        await atlassian.serverEnvironment(),
        version,
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
        event.affectsConfiguration('codebrain.autoRefresh.debounceMs')
      ) {
        didChange.fire();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => didChange.fire()),
  );
}
