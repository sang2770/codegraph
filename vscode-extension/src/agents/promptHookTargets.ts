/**
 * Installing the CodeBrain ticket hook into Claude Code.
 *
 * Claude Code runs `UserPromptSubmit` command hooks before every prompt and adds
 * their stdout to the agent's context. The Atlassian server bundle doubles as
 * that hook (`--prompt-hook`, see `atlassian/promptHook.ts`), so a prompt that
 * names a Jira ticket — or works on the branch's ticket — arrives with the
 * ticket, its acceptance criteria and its spec already attached.
 *
 *   | Scope   | File                               |
 *   |---------|------------------------------------|
 *   | global  | `~/.claude/settings.json`          |
 *   | project | `<ws>/.claude/settings.json`       |
 *
 * Only our own hook entry is ever touched: sibling hooks — the user's, or
 * CodeGraph's own `codegraph prompt-hook` — are preserved, and a settings file
 * that is not valid JSON is refused rather than rebuilt, because it holds far
 * more than hooks.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { McpScope, McpServerEntry, TargetPaths, WriteAction } from './mcpTargets';

export const PROMPT_HOOK_FLAG = '--prompt-hook';
/** Seconds Claude Code waits before giving up on the hook. */
const HOOK_TIMEOUT_SECONDS = 15;

/** Recognises our hook command whatever runtime path or quoting it was written with. */
const OUR_HOOK = /atlassian-server\.js["']?\s+--prompt-hook(?:\s|$)/;

export function isPromptHookCommand(command: unknown): boolean {
  return typeof command === 'string' && OUR_HOOK.test(command);
}

/**
 * The shell command Claude Code runs. Paths are quoted (install directories
 * contain spaces on Windows and macOS) and use forward slashes, which Node
 * accepts everywhere and a POSIX shell will not mangle.
 */
export function promptHookCommand(entry: McpServerEntry): string {
  const quote = (value: string): string => `"${value.replaceAll('\\', '/').replaceAll('"', '\\"')}"`;
  return [quote(entry.command), ...entry.args.map(quote), PROMPT_HOOK_FLAG].join(' ');
}

export function claudeSettingsPath(paths: TargetPaths, scope: McpScope): string | undefined {
  const base = scope === 'global' ? paths.homeDir : paths.workspaceRoot;
  return base ? join(base, '.claude', 'settings.json') : undefined;
}

type Settings = Record<string, unknown> & { hooks?: Record<string, unknown> };
interface HookGroup {
  matcher?: string;
  hooks?: { type?: string; command?: unknown; timeout?: number }[];
}

/** `undefined` for a file that exists but is not a JSON object. */
function readSettings(path: string): Settings | undefined {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Settings) : undefined;
  } catch {
    return undefined;
  }
}

function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function promptGroups(settings: Settings): HookGroup[] | undefined {
  const groups = settings.hooks?.UserPromptSubmit;
  return Array.isArray(groups) ? (groups as HookGroup[]) : undefined;
}

export interface PromptHookWriteResult {
  scope: McpScope;
  action: WriteAction;
  path?: string;
  reason?: string;
}

/** Add our hook, or repoint an existing one at this build. Idempotent. */
export function installPromptHook(
  entry: McpServerEntry,
  paths: TargetPaths,
  scope: McpScope,
): PromptHookWriteResult {
  const path = claudeSettingsPath(paths, scope);
  if (!path) {
    return { scope, action: 'skipped', reason: 'Claude Code keeps project settings in the workspace, and no folder is open.' };
  }
  const settings = readSettings(path);
  if (!settings) {
    return { scope, action: 'skipped', path, reason: `${path} is not valid JSON; fix it and install again.` };
  }

  const command = promptHookCommand(entry);
  const existed = existsSync(path);
  const hooks =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {};
  const groups = promptGroups({ hooks }) ?? [];

  let found = false;
  let changed = false;
  for (const group of groups) {
    for (const hook of group?.hooks ?? []) {
      if (!isPromptHookCommand(hook?.command)) continue;
      found = true;
      if (hook.command !== command || hook.timeout !== HOOK_TIMEOUT_SECONDS) {
        hook.command = command;
        hook.timeout = HOOK_TIMEOUT_SECONDS;
        changed = true;
      }
    }
  }
  if (found && !changed) return { scope, action: 'unchanged', path };
  if (!found) {
    groups.push({ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }] });
  }
  settings.hooks = { ...hooks, UserPromptSubmit: groups };
  writeSettings(path, settings);
  return { scope, action: existed ? 'updated' : 'created', path };
}

/** Our hook at each scope where it is installed, with the command it runs. */
export function readInstalledPromptHooks(paths: TargetPaths): { scope: McpScope; path: string; command: string }[] {
  const found: { scope: McpScope; path: string; command: string }[] = [];
  for (const scope of ['global', 'project'] as const) {
    const path = claudeSettingsPath(paths, scope);
    if (!path || !existsSync(path)) continue;
    const settings = readSettings(path);
    for (const group of (settings && promptGroups(settings)) ?? []) {
      for (const hook of group?.hooks ?? []) {
        if (isPromptHookCommand(hook?.command)) found.push({ scope, path, command: String(hook.command) });
      }
    }
  }
  return found;
}

/** Remove our hook from both scopes; empty groups and sections we emptied go too. */
export function removePromptHook(paths: TargetPaths): { action: 'removed' | 'not-found'; paths: string[] } {
  const removed: string[] = [];
  for (const scope of ['global', 'project'] as const) {
    const path = claudeSettingsPath(paths, scope);
    if (!path || !existsSync(path)) continue;
    const settings = readSettings(path);
    const groups = settings && promptGroups(settings);
    if (!settings || !groups) continue;

    let touched = false;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      const kept = group.hooks.filter((hook) => !isPromptHookCommand(hook?.command));
      if (kept.length !== group.hooks.length) {
        group.hooks = kept;
        touched = true;
      }
    }
    if (!touched) continue;

    const remaining = groups.filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    const hooks = settings.hooks as Record<string, unknown>;
    if (remaining.length > 0) hooks.UserPromptSubmit = remaining;
    else delete hooks.UserPromptSubmit;
    if (Object.keys(hooks).length === 0) delete settings.hooks;
    writeSettings(path, settings);
    removed.push(path);
  }
  return { action: removed.length > 0 ? 'removed' : 'not-found', paths: removed };
}

/** Repoint hooks the user already has at this build's runtime and script. */
export function refreshPromptHooks(entry: McpServerEntry, paths: TargetPaths): PromptHookWriteResult[] {
  const command = promptHookCommand(entry);
  const stale = new Set(
    readInstalledPromptHooks(paths)
      .filter((hook) => hook.command !== command)
      .map((hook) => hook.scope),
  );
  return [...stale].map((scope) => installPromptHook(entry, paths, scope));
}
