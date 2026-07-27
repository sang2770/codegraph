import * as vscode from 'vscode';
import {
  codeGraphEnvironment,
  locateRuntime,
  RuntimeCommand,
} from './runtime';
import { getWorkspaceFolder } from './workspace';

const PROVIDER_ID = 'codegraph.runtime';

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
        'CodeGraph',
        runtime.command,
        [...runtime.baseArgs, 'serve', '--mcp'],
        codeGraphEnvironment(),
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
        event.affectsConfiguration('codegraph.autoRefresh.enabled') ||
        event.affectsConfiguration('codegraph.autoRefresh.debounceMs')
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
