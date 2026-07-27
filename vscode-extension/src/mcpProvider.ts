import * as vscode from 'vscode';
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
): void {
  const didChange = new vscode.EventEmitter<void>();
  context.subscriptions.push(didChange);

  const provider: vscode.McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: didChange.event,
    provideMcpServerDefinitions: () => {
      const workspaceFolder = getWorkspaceFolder();
      const definition = new vscode.McpStdioServerDefinition(
        'CodeBrain',
        runtime.command,
        [...runtime.baseArgs, 'serve', '--mcp'],
        codeBrainEnvironment(),
        String(context.extension.packageJSON.version),
      );
      definition.cwd = workspaceFolder?.uri;
      return [definition];
    },
    resolveMcpServerDefinition: (server) => server,
  };

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider),
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
