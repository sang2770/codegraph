import * as vscode from 'vscode';
import { AtlassianIntegration } from './atlassianSetup';
import {
  codeBrainEnvironment,
  locateRuntime,
  RuntimeCommand,
} from './runtime';
import { getWorkspaceFolder } from './workspace';

const PROVIDER_ID = 'codebrain.runtime';

export function registerMcpProvider(
  context: vscode.ExtensionContext,
  runtime: RuntimeCommand,
  atlassian: AtlassianIntegration,
): void {
  const didChange = new vscode.EventEmitter<void>();
  context.subscriptions.push(didChange);

  const version = String(context.extension.packageJSON.version);

  const provider: vscode.McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: didChange.event,
    provideMcpServerDefinitions: async () => {
      const workspaceFolder = getWorkspaceFolder();
      const codeBrain = new vscode.McpStdioServerDefinition(
        'CodeBrain',
        runtime.command,
        [...runtime.baseArgs, 'serve', '--mcp'],
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
        runtime.command,
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

export function validateBundledRuntime(
  context: vscode.ExtensionContext,
): RuntimeCommand {
  return locateRuntime(context.extensionUri);
}
