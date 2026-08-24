/**
 * Registering the bundled Atlassian MCP server with agents that live outside
 * VS Code.
 *
 * Copilot gets the server through `McpServerDefinitionProvider` (see
 * `src/mcpProvider.ts`) — no file on disk. The other three agents each read
 * their own config file, so this module writes one entry per agent:
 *
 *   | Agent       | File                                            | Scope     |
 *   |-------------|-------------------------------------------------|-----------|
 *   | Claude Code | `<workspace>/.mcp.json`                         | project   |
 *   | Codex CLI   | `~/.codex/config.toml`                          | user      |
 *   | Antigravity | `~/.gemini/config/mcp_config.json` (or legacy)   | user      |
 *
 * Two invariants hold for every target:
 *
 *  - **No secrets on disk here.** The entry carries only the command to run;
 *    the server resolves tokens itself from `~/.codebrain/atlassian.env`. That
 *    matters most for Claude Code, whose `.mcp.json` is frequently committed.
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

/** The key/table name this server is registered under, in every config. */
export const MCP_SERVER_KEY = 'codebrain-atlassian';

export type AtlassianTargetId = 'claude' | 'codex' | 'antigravity';

export interface AtlassianMcpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface TargetPaths {
  homeDir: string;
  /** Required by Claude Code (project-scoped); ignored by the others. */
  workspaceRoot?: string;
}

export type WriteAction = 'created' | 'updated' | 'unchanged' | 'skipped';

export interface TargetWriteResult {
  target: AtlassianTargetId;
  displayName: string;
  action: WriteAction;
  path?: string;
  /** Set when `action` is `skipped`. */
  reason?: string;
}

export interface TargetRemoveResult {
  target: AtlassianTargetId;
  displayName: string;
  action: 'removed' | 'not-found' | 'skipped';
  paths: string[];
  reason?: string;
}

export interface TargetDescriptor {
  id: AtlassianTargetId;
  displayName: string;
  detail: string;
  scope: 'project' | 'user';
}

export const ATLASSIAN_TARGETS: readonly TargetDescriptor[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    detail: '<workspace>/.mcp.json — project scope, safe to commit (no tokens)',
    scope: 'project',
  },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    detail: '~/.codex/config.toml — [mcp_servers.codebrain-atlassian]',
    scope: 'user',
  },
  {
    id: 'antigravity',
    displayName: 'Antigravity',
    detail: '~/.gemini/config/mcp_config.json',
    scope: 'user',
  },
];

// ------------------------------------------------------------------- paths

function claudeConfigPath(paths: TargetPaths): string | undefined {
  // Claude Code reads project-level MCP servers from `./.mcp.json` only —
  // never from a project `./.claude.json`.
  return paths.workspaceRoot ? join(paths.workspaceRoot, '.mcp.json') : undefined;
}

function codexConfigPath(paths: TargetPaths): string {
  return join(paths.homeDir, '.codex', 'config.toml');
}

function antigravityUnifiedPath(paths: TargetPaths): string {
  return join(paths.homeDir, '.gemini', 'config', 'mcp_config.json');
}

function antigravityLegacyPath(paths: TargetPaths): string {
  return join(paths.homeDir, '.gemini', 'antigravity', 'mcp_config.json');
}

/**
 * Antigravity migrated its MCP config from `~/.gemini/antigravity/` to the
 * unified `~/.gemini/config/`, marking the move with a `.migrated` file. Write
 * to the unified path once either signal is present, so a migrated install does
 * not get an entry the IDE will never read.
 */
export function antigravityConfigPath(paths: TargetPaths): string {
  const unified = antigravityUnifiedPath(paths);
  if (existsSync(join(paths.homeDir, '.gemini', 'config', '.migrated'))) return unified;
  if (existsSync(unified)) return unified;
  return antigravityLegacyPath(paths);
}

/** Every file a target may hold an entry in — used when removing. */
export function targetConfigPaths(id: AtlassianTargetId, paths: TargetPaths): string[] {
  switch (id) {
    case 'claude': {
      const path = claudeConfigPath(paths);
      return path ? [path] : [];
    }
    case 'codex':
      return [codexConfigPath(paths)];
    case 'antigravity':
      // Sweep both: a user may have installed pre-migration and been moved.
      return [antigravityUnifiedPath(paths), antigravityLegacyPath(paths)];
  }
}

export function describeTarget(id: AtlassianTargetId): TargetDescriptor {
  const descriptor = ATLASSIAN_TARGETS.find((target) => target.id === id);
  if (!descriptor) throw new Error(`Unknown Atlassian MCP target: ${id}`);
  return descriptor;
}

// ------------------------------------------------------------------ install

export function installTarget(
  id: AtlassianTargetId,
  entry: AtlassianMcpEntry,
  paths: TargetPaths,
): TargetWriteResult {
  const descriptor = describeTarget(id);

  switch (id) {
    case 'claude': {
      const path = claudeConfigPath(paths);
      if (!path) {
        return {
          target: id,
          displayName: descriptor.displayName,
          action: 'skipped',
          reason:
            'Claude Code stores project MCP servers in <workspace>/.mcp.json, and no folder is open.',
        };
      }
      // Claude Code accepts (and its own docs use) the explicit stdio type.
      const action = upsertJsonEntry(path, 'mcpServers', { type: 'stdio', ...entry });
      return { target: id, displayName: descriptor.displayName, action, path };
    }

    case 'codex': {
      const path = codexConfigPath(paths);
      const header = `mcp_servers.${MCP_SERVER_KEY}`;
      const block = buildTomlTable(header, {
        command: entry.command,
        args: entry.args,
        ...(entry.env && Object.keys(entry.env).length > 0 ? { env: entry.env } : {}),
      });
      const existed = existsSync(path);
      const { content, action } = upsertTomlTable(readTextFile(path), header, block);
      if (action === 'unchanged') {
        return { target: id, displayName: descriptor.displayName, action: 'unchanged', path };
      }
      writeTextFileAtomic(path, content);
      // `created` means the config file itself is new — the signal a user
      // needs — not merely that the table was appended to an existing file.
      return {
        target: id,
        displayName: descriptor.displayName,
        action: existed ? 'updated' : 'created',
        path,
      };
    }

    case 'antigravity': {
      const path = antigravityConfigPath(paths);
      // Antigravity rejects entries carrying `type: "stdio"` — the servers it
      // manages itself omit the field, and including it keeps the server out of
      // its Customizations UI.
      const action = upsertJsonEntry(path, 'mcpServers', { ...entry });
      return { target: id, displayName: descriptor.displayName, action, path };
    }
  }
}

export function removeTarget(
  id: AtlassianTargetId,
  paths: TargetPaths,
): TargetRemoveResult {
  const descriptor = describeTarget(id);
  const configPaths = targetConfigPaths(id, paths);

  if (configPaths.length === 0) {
    return {
      target: id,
      displayName: descriptor.displayName,
      action: 'skipped',
      paths: [],
      reason: 'No workspace folder is open.',
    };
  }

  const touched: string[] = [];
  for (const path of configPaths) {
    if (!existsSync(path)) continue;
    if (id === 'codex') {
      const { content, action } = removeTomlTable(
        readTextFile(path),
        `mcp_servers.${MCP_SERVER_KEY}`,
      );
      if (action === 'removed') {
        writeTextFileAtomic(path, content.trimEnd() === '' ? '' : `${content.trimEnd()}\n`);
        touched.push(path);
      }
    } else if (removeJsonEntry(path, 'mcpServers')) {
      touched.push(path);
    }
  }

  return {
    target: id,
    displayName: descriptor.displayName,
    action: touched.length > 0 ? 'removed' : 'not-found',
    paths: touched.length > 0 ? touched : configPaths,
  };
}

/**
 * The entry a target currently holds, if any.
 *
 * Used to self-heal on extension upgrade: the entry points at a versioned
 * extension directory, so an update leaves every installed config pointing at
 * a path that no longer exists. Only configs that already opted in are
 * refreshed — this never installs behind the user's back.
 */
export function readInstalledEntry(
  id: AtlassianTargetId,
  paths: TargetPaths,
): { path: string; entry: AtlassianMcpEntry } | undefined {
  for (const path of targetConfigPaths(id, paths)) {
    if (!existsSync(path)) continue;

    if (id === 'codex') {
      const content = readTextFile(path);
      if (!content.includes(`[mcp_servers.${MCP_SERVER_KEY}]`)) continue;
      const block = sliceTomlBlock(content, `[mcp_servers.${MCP_SERVER_KEY}]`);
      const command = /^[ \t]*command[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"/m.exec(block);
      const args = /^[ \t]*args[ \t]*=[ \t]*\[([^\]]*)\]/m.exec(block);
      return {
        path,
        entry: {
          command: unquoteTomlString(command?.[1] ?? ''),
          args: [...(args?.[1] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
            unquoteTomlString(match[1] ?? ''),
          ),
        },
      };
    }

    const parsed = readJsonFile(path);
    const servers = parsed.mcpServers as Record<string, AtlassianMcpEntry> | undefined;
    const entry = servers?.[MCP_SERVER_KEY];
    if (entry) return { path, entry };
  }
  return undefined;
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
  entry: Record<string, unknown>,
): WriteAction {
  const existed = existsSync(path);
  const config = readJsonFile(path);
  const servers = (config[section] as Record<string, unknown> | undefined) ?? {};

  if (deepEqual(servers[MCP_SERVER_KEY], entry)) return 'unchanged';

  config[section] = { ...servers, [MCP_SERVER_KEY]: entry };
  writeTextFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
  return existed ? 'updated' : 'created';
}

function removeJsonEntry(path: string, section: string): boolean {
  const config = readJsonFile(path);
  const servers = config[section] as Record<string, unknown> | undefined;
  if (!servers || !(MCP_SERVER_KEY in servers)) return false;

  delete servers[MCP_SERVER_KEY];
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
 * backup file.
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
