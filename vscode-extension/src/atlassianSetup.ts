/**
 * VS Code side of the Atlassian (Collab + Jira) MCP integration.
 *
 * Owns the three things the standalone server cannot do for itself:
 *
 *  1. **Collecting connection settings.** URLs go to VS Code settings (visible,
 *     syncable, not secret); tokens go to `SecretStorage` (the OS keychain).
 *  2. **Exporting them once.** Codex, Claude Code and Antigravity cannot read
 *     VS Code's keychain, so the resolved set is mirrored to
 *     `~/.codebrain/atlassian.env` (mode 0600). One configure step, every agent
 *     connected — and no token inside any agent's config file.
 *  3. **Registering the server with those agents**, plus refreshing the entries
 *     they already hold when an extension update moves the server's path.
 *
 * Copilot needs none of this plumbing: `src/mcpProvider.ts` hands VS Code the
 * server definition directly, with the credentials passed as process env.
 */

import { homedir } from 'node:os';
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
import {
  ATLASSIAN_TARGETS,
  AtlassianMcpEntry,
  AtlassianTargetId,
  installTarget,
  readInstalledEntry,
  removeTarget,
  TargetPaths,
} from './atlassian/targets';
import { RuntimeCommand } from './runtime';
import { getWorkspaceFolder } from './workspace';

const JIRA_TOKEN_SECRET = 'codebrain.atlassian.jiraToken';
const CONFLUENCE_TOKEN_SECRET = 'codebrain.atlassian.confluenceToken';

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

  /** Fires when credentials or URLs change, so the MCP provider can refresh. */
  readonly onDidChange = this.didChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: RuntimeCommand,
  ) {
    this.output = vscode.window.createOutputChannel('CodeBrain Atlassian');
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
  serverEntry(): AtlassianMcpEntry {
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
        `CodeBrain could not write ${envFile} (${message}). Copilot still works; Claude Code, Codex and Antigravity will not see the credentials.`,
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
  async install(): Promise<void> {
    const paths = this.targetPaths();
    const picks = await vscode.window.showQuickPick(
      ATLASSIAN_TARGETS.map((target) => ({
        label: target.displayName,
        detail: target.detail,
        id: target.id,
        picked: true,
      })),
      {
        canPickMany: true,
        title: 'CodeBrain: register the Atlassian MCP server',
        placeHolder: 'Copilot is already covered by the extension itself',
      },
    );
    if (!picks || picks.length === 0) return;

    const entry = this.serverEntry();
    const succeeded: string[] = [];
    const skipped: string[] = [];

    for (const pick of picks) {
      try {
        const result = installTarget(pick.id as AtlassianTargetId, entry, paths);
        this.log(
          `${result.displayName}: ${result.action}${result.path ? ` (${result.path})` : ''}${result.reason ? ` — ${result.reason}` : ''}`,
        );
        if (result.action === 'skipped') {
          skipped.push(`${result.displayName} — ${result.reason ?? 'not applicable'}`);
        } else {
          succeeded.push(`${result.displayName} (${result.action})`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`${pick.label}: failed — ${message}`);
        skipped.push(`${pick.label} — ${message}`);
      }
    }

    if (succeeded.length > 0) {
      void vscode.window.showInformationMessage(
        `CodeBrain Atlassian registered with ${succeeded.join(', ')}. Restart the agent to pick it up.`,
      );
    }
    if (skipped.length > 0) {
      void vscode.window.showWarningMessage(
        `CodeBrain could not register: ${skipped.join('; ')}.`,
      );
    }
  }

  /** Remove the server entry from every agent config that holds one. */
  async remove(): Promise<void> {
    const paths = this.targetPaths();
    const removed: string[] = [];

    for (const target of ATLASSIAN_TARGETS) {
      try {
        const result = removeTarget(target.id, paths);
        this.log(`${result.displayName}: ${result.action} (${result.paths.join(', ')})`);
        if (result.action === 'removed') removed.push(result.displayName);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`${target.displayName}: remove failed — ${message}`);
      }
    }

    void vscode.window.showInformationMessage(
      removed.length > 0
        ? `CodeBrain Atlassian removed from ${removed.join(', ')}.`
        : 'CodeBrain Atlassian was not registered with Claude Code, Codex or Antigravity.',
    );
  }

  /**
   * Re-point config entries that already exist at the current extension path.
   *
   * The entry embeds the extension's install directory, which carries the
   * version number — so every update silently breaks every registered agent
   * until the entry is rewritten. Only agents that already opted in are
   * touched, and an entry that is already correct is left alone.
   */
  async refreshInstalledTargets(): Promise<void> {
    const paths = this.targetPaths();
    const entry = this.serverEntry();

    for (const target of ATLASSIAN_TARGETS) {
      let installed: ReturnType<typeof readInstalledEntry>;
      try {
        installed = readInstalledEntry(target.id, paths);
      } catch (error) {
        this.log(
          `${target.displayName}: could not read config — ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!installed) continue;

      const installedScript = installed.entry.args?.[0];
      const stale =
        installed.entry.command !== entry.command || installedScript !== entry.args[0];
      if (!stale) continue;

      try {
        const result = installTarget(target.id, entry, paths);
        this.log(`${result.displayName}: refreshed stale server path (${result.action})`);
      } catch (error) {
        this.log(
          `${target.displayName}: refresh failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private targetPaths(): TargetPaths {
    return {
      homeDir: homedir(),
      workspaceRoot: getWorkspaceFolder()?.uri.fsPath,
    };
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
