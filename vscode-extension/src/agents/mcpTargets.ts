/**
 * Registering an MCP server the extension ships with agents that live outside
 * VS Code.
 *
 * Copilot gets its servers through `McpServerDefinitionProvider` (see
 * `src/mcpProvider.ts`) — no file on disk. Every other agent reads its own
 * config file, so this module writes one entry per agent, at the scope the
 * user picked:
 *
 *   | Agent       | Global                             | Project                      |
 *   |-------------|------------------------------------|------------------------------|
 *   | Claude Code | `~/.claude.json`                   | `<workspace>/.mcp.json`      |
 *   | Codex CLI   | `~/.codex/config.toml`             | — (no project config)        |
 *   | Gemini CLI  | `~/.gemini/settings.json`          | `<workspace>/.gemini/…json`  |
 *   | Antigravity | `~/.gemini/config/mcp_config.json` | — (no project config)        |
 *
 * Codex and Antigravity genuinely have no project-scoped MCP config, so asking
 * for one is reported as `skipped` with a reason rather than written somewhere
 * the agent will never read.
 *
 * The module is server-agnostic: every entry point takes the key the server is
 * registered under (`codebrain`, `codebrain-atlassian`, …), so the code graph
 * server and the Atlassian server share one implementation rather than two
 * copies that drift apart.
 *
 * Two invariants hold for every target:
 *
 *  - **No secrets on disk here.** An entry carries the command to run and, at
 *    most, non-secret tuning env vars; servers that need credentials resolve
 *    them themselves (the Atlassian one reads `~/.codebrain/atlassian.env`).
 *    That matters most for Claude Code, whose `.mcp.json` is frequently
 *    committed.
 *  - **Surgical writes.** Sibling servers, sibling TOML tables and unrelated
 *    keys are preserved, and a re-run that would produce identical content
 *    reports `unchanged` instead of rewriting the file.
 *
 * Everything takes explicit `homeDir` / `workspaceRoot` paths rather than
 * reading `os.homedir()` internally, so the write behaviour is testable against
 * a temp directory.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { buildTomlTable, removeTomlTable, upsertTomlTable } from './toml';

export type AgentTargetId = 'claude' | 'codex' | 'gemini' | 'antigravity';

/** `global` = every project on this machine; `project` = this workspace only. */
export type McpScope = 'global' | 'project';

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface TargetPaths {
  homeDir: string;
  /** Required by every project-scoped write; ignored by the global ones. */
  workspaceRoot?: string;
}

export type WriteAction = 'created' | 'updated' | 'unchanged' | 'skipped';

/** One config file a target may hold an entry in. */
export interface TargetConfigFile {
  path: string;
  scope: McpScope;
  format: 'json' | 'toml';
}

export interface TargetWriteResult {
  target: AgentTargetId;
  displayName: string;
  scope: McpScope;
  action: WriteAction;
  path?: string;
  /** Set when `action` is `skipped`. */
  reason?: string;
}

export interface TargetRemoveResult {
  target: AgentTargetId;
  displayName: string;
  action: 'removed' | 'not-found' | 'skipped';
  paths: string[];
  reason?: string;
}

export interface TargetDescriptor {
  id: AgentTargetId;
  displayName: string;
  detail: string;
  /** False when the agent has no config at this scope at all. */
  supported: boolean;
}

/** The agents an extension-hosted MCP server can be registered with. */
export const AGENT_TARGET_IDS: readonly AgentTargetId[] = [
  'claude',
  'codex',
  'gemini',
  'antigravity',
];

export const MCP_SCOPES: readonly McpScope[] = ['global', 'project'];

/** Agents whose only config is user-wide — asking for project scope is a no-op. */
function supportsScope(id: AgentTargetId, scope: McpScope): boolean {
  if (scope === 'global') return true;
  return id === 'claude' || id === 'gemini';
}

/**
 * How each target is presented in the picker at a given scope. The Codex line
 * names the TOML table it writes, so it depends on the server key.
 */
export function describeTargets(
  serverKey: string,
  scope: McpScope,
): readonly TargetDescriptor[] {
  const unsupported = (id: AgentTargetId, displayName: string): TargetDescriptor => ({
    id,
    displayName,
    detail: `${displayName} has no project-scoped MCP config — register it globally instead.`,
    supported: false,
  });

  return [
    {
      id: 'claude',
      displayName: 'Claude Code',
      detail:
        scope === 'global'
          ? '~/.claude.json — every project on this machine'
          : '<workspace>/.mcp.json — this workspace, safe to commit (no tokens)',
      supported: true,
    },
    scope === 'global'
      ? {
          id: 'codex',
          displayName: 'Codex CLI',
          detail: `~/.codex/config.toml — [mcp_servers.${serverKey}]`,
          supported: true,
        }
      : unsupported('codex', 'Codex CLI'),
    {
      id: 'gemini',
      displayName: 'Gemini CLI',
      detail:
        scope === 'global'
          ? '~/.gemini/settings.json — mcpServers'
          : '<workspace>/.gemini/settings.json — mcpServers',
      supported: true,
    },
    scope === 'global'
      ? {
          id: 'antigravity',
          displayName: 'Antigravity',
          detail: '~/.gemini/config/mcp_config.json',
          supported: true,
        }
      : unsupported('antigravity', 'Antigravity'),
  ];
}

export function describeTarget(
  serverKey: string,
  id: AgentTargetId,
  scope: McpScope,
): TargetDescriptor {
  const descriptor = describeTargets(serverKey, scope).find((target) => target.id === id);
  if (!descriptor) throw new Error(`Unknown MCP target: ${id}`);
  return descriptor;
}

/** The agent's name on its own, independent of scope — for logs and messages. */
export function targetDisplayName(id: AgentTargetId): string {
  return describeTarget('', id, 'global').displayName;
}

// ------------------------------------------------------------------- paths

/**
 * Antigravity migrated its MCP config from `~/.gemini/antigravity/` to the
 * unified `~/.gemini/config/`, marking the move with a `.migrated` file. Write
 * to the unified path once either signal is present, so a migrated install does
 * not get an entry the IDE will never read.
 */
export function antigravityConfigPath(paths: TargetPaths): string {
  const unified = join(paths.homeDir, '.gemini', 'config', 'mcp_config.json');
  if (existsSync(join(paths.homeDir, '.gemini', 'config', '.migrated'))) return unified;
  if (existsSync(unified)) return unified;
  return join(paths.homeDir, '.gemini', 'antigravity', 'mcp_config.json');
}

/**
 * Every file a target may hold an entry in — used when reading and removing.
 * Pass a `scope` to narrow it to one; omit it to sweep both, which is what an
 * unregister has to do to leave nothing behind.
 */
export function targetConfigFiles(
  id: AgentTargetId,
  paths: TargetPaths,
  scope?: McpScope,
): TargetConfigFile[] {
  const files: TargetConfigFile[] = [];
  const project = (path: string): void => {
    if (paths.workspaceRoot) files.push({ path, scope: 'project', format: 'json' });
  };

  switch (id) {
    case 'claude':
      // Claude Code reads project-level MCP servers from `./.mcp.json` only —
      // never from a project `./.claude.json`.
      files.push({ path: join(paths.homeDir, '.claude.json'), scope: 'global', format: 'json' });
      if (paths.workspaceRoot) project(join(paths.workspaceRoot, '.mcp.json'));
      break;
    case 'codex':
      files.push({
        path: join(paths.homeDir, '.codex', 'config.toml'),
        scope: 'global',
        format: 'toml',
      });
      break;
    case 'gemini':
      // Gemini CLI (and the rebranded Antigravity CLI) read MCP servers from
      // `settings.json` — a different file from the Antigravity IDE's
      // `mcp_config.json` below, even though both live under `~/.gemini`.
      files.push({
        path: join(paths.homeDir, '.gemini', 'settings.json'),
        scope: 'global',
        format: 'json',
      });
      if (paths.workspaceRoot) {
        project(join(paths.workspaceRoot, '.gemini', 'settings.json'));
      }
      break;
    case 'antigravity':
      // Sweep both: a user may have installed pre-migration and been moved.
      files.push(
        {
          path: join(paths.homeDir, '.gemini', 'config', 'mcp_config.json'),
          scope: 'global',
          format: 'json',
        },
        {
          path: join(paths.homeDir, '.gemini', 'antigravity', 'mcp_config.json'),
          scope: 'global',
          format: 'json',
        },
      );
      break;
  }

  return scope ? files.filter((file) => file.scope === scope) : files;
}

/** The single file an install writes, or `undefined` when there is none. */
export function targetWriteFile(
  id: AgentTargetId,
  paths: TargetPaths,
  scope: McpScope,
): TargetConfigFile | undefined {
  if (!supportsScope(id, scope)) return undefined;
  if (id === 'antigravity') {
    return { path: antigravityConfigPath(paths), scope: 'global', format: 'json' };
  }
  return targetConfigFiles(id, paths, scope)[0];
}

// ------------------------------------------------------------------ install

export function installTarget(
  serverKey: string,
  id: AgentTargetId,
  entry: McpServerEntry,
  paths: TargetPaths,
  scope: McpScope,
): TargetWriteResult {
  const displayName = targetDisplayName(id);
  const skip = (reason: string): TargetWriteResult => ({
    target: id,
    displayName,
    scope,
    action: 'skipped',
    reason,
  });

  if (!supportsScope(id, scope)) {
    return skip(`${displayName} has no project-scoped MCP config; register it globally instead.`);
  }

  const file = targetWriteFile(id, paths, scope);
  if (!file) {
    return skip(
      `${displayName} stores project MCP servers inside the workspace, and no folder is open.`,
    );
  }

  if (file.format === 'toml') {
    const header = `mcp_servers.${serverKey}`;
    const block = buildTomlTable(header, {
      command: entry.command,
      args: entry.args,
      ...(entry.env && Object.keys(entry.env).length > 0 ? { env: entry.env } : {}),
    });
    const existed = existsSync(file.path);
    const { content, action } = upsertTomlTable(readTextFile(file.path), header, block);
    if (action === 'unchanged') {
      return { target: id, displayName, scope, action: 'unchanged', path: file.path };
    }
    writeTextFileAtomic(file.path, content);
    // `created` means the config file itself is new — the signal a user needs —
    // not merely that the table was appended to an existing file.
    return {
      target: id,
      displayName,
      scope,
      action: existed ? 'updated' : 'created',
      path: file.path,
    };
  }

  // Claude Code accepts (and its own docs use) the explicit stdio type.
  // Antigravity, by contrast, rejects entries carrying it — the servers it
  // manages itself omit the field, and including it keeps the server out of its
  // Customizations UI. Gemini's schema has no `type` either, and no `trust`
  // means it keeps asking before running a tool, which stays the user's call.
  const payload = id === 'claude' ? { type: 'stdio', ...entry } : { ...entry };
  const action = upsertJsonEntry(file.path, 'mcpServers', serverKey, payload);
  return { target: id, displayName, scope, action, path: file.path };
}

/**
 * Remove the entry from the target's config. With no `scope` this sweeps every
 * file the target may hold one in, so an unregister leaves nothing behind at
 * either scope.
 */
export function removeTarget(
  serverKey: string,
  id: AgentTargetId,
  paths: TargetPaths,
  scope?: McpScope,
): TargetRemoveResult {
  const displayName = targetDisplayName(id);
  const files = targetConfigFiles(id, paths, scope);

  if (files.length === 0) {
    return {
      target: id,
      displayName,
      action: 'skipped',
      paths: [],
      reason:
        scope === 'project'
          ? `${displayName} has no project-scoped MCP config.`
          : 'No workspace folder is open.',
    };
  }

  const touched: string[] = [];
  for (const file of files) {
    if (!existsSync(file.path)) continue;
    if (file.format === 'toml') {
      const { content, action } = removeTomlTable(
        readTextFile(file.path),
        `mcp_servers.${serverKey}`,
      );
      if (action === 'removed') {
        writeTextFileAtomic(
          file.path,
          content.trimEnd() === '' ? '' : `${content.trimEnd()}\n`,
        );
        touched.push(file.path);
      }
    } else if (removeJsonEntry(file.path, 'mcpServers', serverKey)) {
      touched.push(file.path);
    }
  }

  return {
    target: id,
    displayName,
    action: touched.length > 0 ? 'removed' : 'not-found',
    paths: touched.length > 0 ? touched : files.map((file) => file.path),
  };
}

/**
 * Every entry this target currently holds, across both scopes.
 *
 * Used to self-heal on extension upgrade: the entry points at a versioned
 * extension directory, so an update leaves every installed config pointing at
 * a path that no longer exists. Both scopes are returned because a user may
 * have registered globally in one place and per-project in another, and only
 * configs that already opted in are ever rewritten — this never installs behind
 * the user's back.
 */
export function readInstalledEntries(
  serverKey: string,
  id: AgentTargetId,
  paths: TargetPaths,
): { file: TargetConfigFile; entry: McpServerEntry }[] {
  const found: { file: TargetConfigFile; entry: McpServerEntry }[] = [];

  for (const file of targetConfigFiles(id, paths)) {
    if (!existsSync(file.path)) continue;

    if (file.format === 'toml') {
      const content = readTextFile(file.path);
      if (!content.includes(`[mcp_servers.${serverKey}]`)) continue;
      const block = sliceTomlBlock(content, `[mcp_servers.${serverKey}]`);
      const command = /^[ \t]*command[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"/m.exec(block);
      const args = /^[ \t]*args[ \t]*=[ \t]*\[([^\]]*)\]/m.exec(block);
      found.push({
        file,
        entry: {
          command: unquoteTomlString(command?.[1] ?? ''),
          args: [...(args?.[1] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
            unquoteTomlString(match[1] ?? ''),
          ),
        },
      });
      continue;
    }

    const parsed = readJsonFile(file.path);
    const servers = parsed.mcpServers as Record<string, McpServerEntry> | undefined;
    const entry = servers?.[serverKey];
    if (entry) found.push({ file, entry });
  }

  return found;
}

/**
 * True when a registered entry no longer points at the command this build
 * would write — the state every extension update leaves behind, since the
 * install directory carries the version number.
 *
 * Only the command and its arguments are compared: `env` is not read back from
 * Codex's TOML, and a tuning value that drifted is not worth rewriting four
 * config files over.
 */
export function isEntryStale(installed: McpServerEntry, current: McpServerEntry): boolean {
  if (installed.command !== current.command) return true;
  const args = installed.args ?? [];
  return (
    args.length !== current.args.length ||
    args.some((argument, index) => argument !== current.args[index])
  );
}

/** Reverse {@link buildTomlTable}'s escaping for the shallow read above. */
function unquoteTomlString(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

/** The text of a TOML block, used only for the shallow command read above. */
function sliceTomlBlock(content: string, headerLine: string): string {
  const start = content.indexOf(headerLine);
  if (start === -1) return '';
  const nextHeader = content.indexOf('\n[', start + headerLine.length);
  return content.slice(start, nextHeader === -1 ? undefined : nextHeader);
}

// -------------------------------------------------------------- JSON / files

function upsertJsonEntry(
  path: string,
  section: string,
  serverKey: string,
  entry: Record<string, unknown>,
): WriteAction {
  const existed = existsSync(path);
  const config = readJsonFile(path);
  const servers = (config[section] as Record<string, unknown> | undefined) ?? {};

  if (deepEqual(servers[serverKey], entry)) return 'unchanged';

  config[section] = { ...servers, [serverKey]: entry };
  writeTextFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
  return existed ? 'updated' : 'created';
}

function removeJsonEntry(path: string, section: string, serverKey: string): boolean {
  const config = readJsonFile(path);
  const servers = config[section] as Record<string, unknown> | undefined;
  if (!servers || !(serverKey in servers)) return false;

  delete servers[serverKey];
  if (Object.keys(servers).length === 0) delete config[section];
  writeTextFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

/**
 * Read a JSON config, returning `{}` when missing or unparseable.
 *
 * An unparseable file is copied to `<path>.backup` first: the user's config is
 * about to be replaced by one built from `{}`, and losing it silently — over a
 * transient syntax error mid-edit — would be a far worse outcome than a stray
 * backup file. This matters most for `~/.claude.json`, which is Claude Code's
 * own state file and holds far more than MCP servers.
 */
function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readTextFile(path);
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    try {
      writeFileSync(`${path}.backup`, raw, 'utf8');
    } catch {
      // A missing backup must not block the repair write.
    }
    return {};
  }
}

function readTextFile(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

/** Write via temp file + rename so a crash cannot leave a half-written config. */
function writeTextFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(temp, content, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The original failure is the one worth reporting.
    }
    throw error;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && deepEqual(left[key], right[key]));
}
