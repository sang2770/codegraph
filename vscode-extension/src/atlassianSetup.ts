/**
 * VS Code side of the Atlassian (Collab + Jira) MCP integration.
 *
 * Owns the three things the standalone server cannot do for itself:
 *
 *  1. **Collecting connection settings.** URLs go to VS Code settings (visible,
 *     syncable, not secret); tokens go to `SecretStorage` (the OS keychain).
 *  2. **Exporting them once.** Codex, Claude Code, Gemini CLI and Antigravity
 *     cannot read VS Code's keychain, so the resolved set is mirrored to
 *     `~/.codebrain/atlassian.env` (mode 0600). One configure step, every agent
 *     connected — and no token inside any agent's config file.
 *  3. **Registering the server with those agents**, plus refreshing the entries
 *     they already hold when an extension update moves the server's path.
 *
 * Copilot needs none of this plumbing: `src/mcpProvider.ts` hands VS Code the
 * server definition directly, with the credentials passed as process env.
 */

import { join } from 'node:path';
import * as vscode from 'vscode';
import { AtlassianClient } from './atlassian/client';
import {
  ATLASSIAN_ENV_KEYS,
  AtlassianConnections,
  AtlassianEnvValues,
  atlassianEnvPath,
  deleteEnvFile,
  describeConnectionProblems,
  isUsableBaseUrl,
  mergeEnvValues,
  normalizeBaseUrl,
  readEnvFile,
  toConnections,
  writeEnvFile,
} from './atlassian/connection';
import { McpServerEntry } from './agents/mcpTargets';
import { McpRegistrar } from './agents/registration';
import { RuntimeCommand } from './runtime';

const JIRA_TOKEN_SECRET = 'codebrain.atlassian.jiraToken';
const CONFLUENCE_TOKEN_SECRET = 'codebrain.atlassian.confluenceToken';

/** The key the Atlassian server is registered under in every agent config. */
export const ATLASSIAN_MCP_KEY = 'codebrain-atlassian';

/** Relative location of the bundled stdio server inside the extension. */
export const ATLASSIAN_SERVER_SCRIPT = join('dist', 'atlassian-server.js');

export interface AtlassianStatus {
  values: AtlassianEnvValues;
  connections: AtlassianConnections;
  envFile: string;
  problems: string[];
}

export class AtlassianIntegration implements vscode.Disposable {
  private readonly didChange = new vscode.EventEmitter<void>();
  private readonly output: vscode.OutputChannel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly registrar: McpRegistrar;

  /** Fires when credentials or URLs change, so the MCP provider can refresh. */
  readonly onDidChange = this.didChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: RuntimeCommand,
  ) {
    this.output = vscode.window.createOutputChannel('CodeBrain Atlassian');
    this.registrar = new McpRegistrar({
      serverKey: ATLASSIAN_MCP_KEY,
      label: 'CodeBrain Atlassian',
      entry: () => this.serverEntry(),
      log: (message) => this.log(message),
    });
    this.disposables.push(
      this.output,
      this.didChange,
      context.secrets.onDidChange((event) => {
        if (event.key === JIRA_TOKEN_SECRET || event.key === CONFLUENCE_TOKEN_SECRET) {
          this.didChange.fire();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codebrain.atlassian')) this.didChange.fire();
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables.reverse()) disposable.dispose();
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  // ------------------------------------------------------------- resolution

  /**
   * Resolve the effective settings.
   *
   * VS Code's own configuration wins, because it is what the user just edited;
   * the shared env file and the process environment fill the gaps, which is how
   * a workspace configured from a terminal (or by a teammate's setup script)
   * works without re-entering anything.
   */
  async status(): Promise<AtlassianStatus> {
    const config = vscode.workspace.getConfiguration('codebrain.atlassian');
    const envFile = atlassianEnvPath();
    const fallback = mergeEnvValues(process.env, readEnvFile(envFile));

    const username = (config.get<string>('username') ?? '').trim();
    const values: AtlassianEnvValues = {};
    const assign = (key: keyof AtlassianEnvValues, value: string | undefined): void => {
      const trimmed = value?.trim();
      if (trimmed) values[key] = trimmed;
    };

    assign('JIRA_URL', config.get<string>('jiraUrl') || fallback.JIRA_URL);
    assign('CONFLUENCE_URL', config.get<string>('confluenceUrl') || fallback.CONFLUENCE_URL);
    assign(
      'JIRA_PERSONAL_TOKEN',
      (await this.context.secrets.get(JIRA_TOKEN_SECRET)) || fallback.JIRA_PERSONAL_TOKEN,
    );
    assign(
      'CONFLUENCE_PERSONAL_TOKEN',
      (await this.context.secrets.get(CONFLUENCE_TOKEN_SECRET)) ||
        fallback.CONFLUENCE_PERSONAL_TOKEN,
    );
    assign('JIRA_USERNAME', username || fallback.JIRA_USERNAME);
    assign('CONFLUENCE_USERNAME', username || fallback.CONFLUENCE_USERNAME);

    return {
      values,
      connections: toConnections(values),
      envFile,
      problems: describeConnectionProblems(values),
    };
  }

  /** True once at least one product can actually be queried. */
  async isConfigured(): Promise<boolean> {
    const { connections } = await this.status();
    return Boolean(connections.jira || connections.confluence);
  }

  serverScriptPath(): string {
    return join(this.context.extensionUri.fsPath, ATLASSIAN_SERVER_SCRIPT);
  }

  /**
   * The command every agent runs. The extension's bundled Node is used rather
   * than a `node` on PATH: GUI-launched agents get a stripped PATH, and this
   * runtime is guaranteed present and version-correct.
   */
  serverEntry(): McpServerEntry {
    return { command: this.runtime.command, args: [this.serverScriptPath()] };
  }

  /**
   * Environment for the VS Code-hosted server. Credentials are passed inline so
   * Copilot keeps working even if the shared env file could not be written
   * (a read-only home directory, for instance).
   */
  async serverEnvironment(): Promise<Record<string, string>> {
    const { values } = await this.status();
    const config = vscode.workspace.getConfiguration('codebrain.atlassian');
    const environment: Record<string, string> = {};

    for (const key of ATLASSIAN_ENV_KEYS) {
      const value = values[key];
      if (value) environment[key] = value;
    }

    environment.CODEBRAIN_ATLASSIAN_MAX_RESULTS = String(config.get<number>('maxResults', 10));
    environment.CODEBRAIN_ATLASSIAN_MAX_BODY_CHARS = String(
      config.get<number>('maxBodyCharacters', 12000),
    );
    if (config.get<boolean>('sslVerify', true) === false) {
      environment.CODEBRAIN_ATLASSIAN_SSL_VERIFY = 'false';
    }
    return environment;
  }

  // ---------------------------------------------------------------- wizard

  /** Prompt for URLs and tokens, then persist and export them. */
  async configure(): Promise<void> {
    const current = await this.status();
    const config = vscode.workspace.getConfiguration('codebrain.atlassian');

    const products = await vscode.window.showQuickPick(
      [
        {
          label: 'Confluence (Collab)',
          description: current.connections.confluence
            ? `configured — ${current.connections.confluence.baseUrl}`
            : 'not configured',
          id: 'confluence' as const,
          picked: true,
        },
        {
          label: 'Jira',
          description: current.connections.jira
            ? `configured — ${current.connections.jira.baseUrl}`
            : 'not configured',
          id: 'jira' as const,
          picked: true,
        },
      ],
      {
        canPickMany: true,
        title: 'CodeBrain: Configure Atlassian',
        placeHolder: 'Choose the products to configure',
      },
    );
    if (!products || products.length === 0) return;

    const next: AtlassianEnvValues = { ...current.values };

    for (const product of products) {
      const isJira = product.id === 'jira';
      const label = isJira ? 'Jira' : 'Confluence (Collab)';
      const urlKey = isJira ? 'JIRA_URL' : 'CONFLUENCE_URL';
      const tokenKey = isJira ? 'JIRA_PERSONAL_TOKEN' : 'CONFLUENCE_PERSONAL_TOKEN';

      const url = await vscode.window.showInputBox({
        title: `${label} base URL`,
        prompt: isJira
          ? 'For example https://jira.example.com (Cloud: https://your-site.atlassian.net)'
          : 'Include the context path. For example https://collab.example.com (Cloud: https://your-site.atlassian.net/wiki)',
        value: current.values[urlKey] ?? '',
        ignoreFocusOut: true,
        validateInput: (input) =>
          input.trim() === '' || isUsableBaseUrl(input)
            ? undefined
            : 'Enter an http(s) URL, or leave empty to skip this product.',
      });
      if (url === undefined) return; // Escaped: leave everything untouched.

      if (url.trim() === '') {
        delete next[urlKey];
        delete next[tokenKey];
        continue;
      }
      next[urlKey] = normalizeBaseUrl(url);

      const hasToken = Boolean(current.values[tokenKey]);
      const token = await vscode.window.showInputBox({
        title: `${label} personal access token`,
        prompt: hasToken
          ? 'Leave empty to keep the stored token.'
          : 'Server/Data Center: Profile → Personal Access Tokens. Cloud: an API token, plus your account email below.',
        password: true,
        ignoreFocusOut: true,
      });
      if (token === undefined) return;
      if (token.trim() !== '') next[tokenKey] = token.trim();
      if (!next[tokenKey]) {
        void vscode.window.showWarningMessage(
          `CodeBrain: no token entered for ${label}; it stays unconfigured until one is provided.`,
        );
      }
    }

    // Cloud uses Basic auth with the account email, so it has to be asked for.
    const needsUsername = [next.JIRA_URL, next.CONFLUENCE_URL].some(
      (url) => url && /\.atlassian\.net/i.test(url),
    );
    let username = (config.get<string>('username') ?? '').trim();
    if (needsUsername) {
      const entered = await vscode.window.showInputBox({
        title: 'Atlassian account email (Cloud only)',
        prompt: 'Cloud API tokens authenticate as email + token. Leave empty for Server/Data Center.',
        value: username,
        ignoreFocusOut: true,
      });
      if (entered === undefined) return;
      username = entered.trim();
    }
    if (username) {
      next.JIRA_USERNAME = username;
      next.CONFLUENCE_USERNAME = username;
    } else {
      delete next.JIRA_USERNAME;
      delete next.CONFLUENCE_USERNAME;
    }

    await this.persist(next, username);

    const status = await this.status();
    for (const problem of status.problems) this.log(`configuration problem: ${problem}`);

    const configured = productSummary(status.connections);
    if (configured.length === 0) {
      void vscode.window.showWarningMessage(
        'CodeBrain: no Atlassian product is fully configured yet — a base URL and a token are both required.',
      );
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      `CodeBrain: ${configured.join(' and ')} ready. Copilot picks the server up automatically.`,
      'Test connection',
      'Register with other agents…',
    );
    if (choice === 'Test connection') await this.testConnection();
    else if (choice === 'Register with other agents…') await this.install();
  }

  /** Store URLs in settings, tokens in the keychain, and export the env file. */
  private async persist(values: AtlassianEnvValues, username: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('codebrain.atlassian');
    await config.update(
      'jiraUrl',
      values.JIRA_URL ?? '',
      vscode.ConfigurationTarget.Global,
    );
    await config.update(
      'confluenceUrl',
      values.CONFLUENCE_URL ?? '',
      vscode.ConfigurationTarget.Global,
    );
    await config.update('username', username, vscode.ConfigurationTarget.Global);

    await this.storeSecret(JIRA_TOKEN_SECRET, values.JIRA_PERSONAL_TOKEN);
    await this.storeSecret(CONFLUENCE_TOKEN_SECRET, values.CONFLUENCE_PERSONAL_TOKEN);

    const envFile = atlassianEnvPath();
    try {
      writeEnvFile(envFile, values);
      this.log(`exported credentials to ${envFile}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed to write ${envFile}: ${message}`);
      void vscode.window.showWarningMessage(
        `CodeBrain could not write ${envFile} (${message}). Copilot still works; Claude Code, Codex, Gemini CLI and Antigravity will not see the credentials.`,
      );
    }

    this.didChange.fire();
  }

  private async storeSecret(key: string, value: string | undefined): Promise<void> {
    if (value) await this.context.secrets.store(key, value);
    else await this.context.secrets.delete(key);
  }

  // -------------------------------------------------------- agent targeting

  /** Ask which agents to register with, then write their config files. */
  install(): Promise<void> {
    return this.registrar.install();
  }

  /** Remove the server entry from every agent config that holds one. */
  remove(): Promise<void> {
    return this.registrar.remove();
  }

  /** Repair entries left pointing at the previous extension version's path. */
  refreshInstalledTargets(): void {
    this.registrar.refreshInstalledTargets();
  }

  // ------------------------------------------------------------ diagnostics

  /** Make one authenticated call per configured product and report the result. */
  async testConnection(): Promise<void> {
    const { connections, problems, envFile } = await this.status();
    if (!connections.jira && !connections.confluence) {
      const choice = await vscode.window.showWarningMessage(
        `CodeBrain: no Atlassian product is configured${problems.length > 0 ? ` (${problems.join(' ')})` : ''}.`,
        'Configure…',
      );
      if (choice === 'Configure…') await this.configure();
      return;
    }

    const config = vscode.workspace.getConfiguration('codebrain.atlassian');
    const client = new AtlassianClient({ connections });
    const lines: string[] = [];

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CodeBrain: testing Atlassian access…' },
      async () => {
        if (connections.jira) {
          try {
            const me = await client.jiraWhoAmI();
            lines.push(
              `Jira OK — ${connections.jira.baseUrl} as ${me.displayName ?? me.name ?? me.emailAddress ?? 'authenticated user'}`,
            );
          } catch (error) {
            lines.push(`Jira FAILED — ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (connections.confluence) {
          try {
            await client.confluenceProbe();
            lines.push(`Confluence OK — ${connections.confluence.baseUrl}`);
          } catch (error) {
            lines.push(
              `Confluence FAILED — ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      },
    );

    for (const line of lines) this.log(line);
    this.log(`credentials file: ${envFile}`);
    if (config.get<boolean>('sslVerify', true) === false) {
      this.log('TLS verification is disabled (codebrain.atlassian.sslVerify = false).');
    }

    const failed = lines.some((line) => line.includes('FAILED'));
    if (failed) {
      const choice = await vscode.window.showErrorMessage(
        `CodeBrain Atlassian: ${lines.join(' | ')}`,
        'Show log',
        'Reconfigure…',
      );
      if (choice === 'Show log') this.output.show(true);
      else if (choice === 'Reconfigure…') await this.configure();
    } else {
      void vscode.window.showInformationMessage(`CodeBrain Atlassian: ${lines.join(' | ')}`);
    }
  }

  /** Forget the tokens, the URLs and the exported env file. */
  async clear(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      'Remove the stored Atlassian tokens, URLs, and the shared credentials file?',
      { modal: true, detail: 'Agent config files are left in place — they hold no secrets. Use "Unregister" to remove those too.' },
      'Remove',
    );
    if (confirmed !== 'Remove') return;

    const config = vscode.workspace.getConfiguration('codebrain.atlassian');
    await config.update('jiraUrl', undefined, vscode.ConfigurationTarget.Global);
    await config.update('confluenceUrl', undefined, vscode.ConfigurationTarget.Global);
    await config.update('username', undefined, vscode.ConfigurationTarget.Global);
    await this.context.secrets.delete(JIRA_TOKEN_SECRET);
    await this.context.secrets.delete(CONFLUENCE_TOKEN_SECRET);

    const envFile = atlassianEnvPath();
    let removedFile = false;
    try {
      removedFile = deleteEnvFile(envFile);
    } catch (error) {
      this.log(
        `could not delete ${envFile} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.didChange.fire();
    void vscode.window.showInformationMessage(
      `CodeBrain: Atlassian credentials cleared${removedFile ? ` and ${envFile} deleted` : ''}.`,
    );
  }
}

function productSummary(connections: AtlassianConnections): string[] {
  const configured: string[] = [];
  if (connections.confluence) configured.push('Confluence (Collab)');
  if (connections.jira) configured.push('Jira');
  return configured;
}
