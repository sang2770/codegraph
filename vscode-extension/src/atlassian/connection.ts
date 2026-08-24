/**
 * Connection settings for the bundled Atlassian MCP server.
 *
 * Two consumers with different needs share this module:
 *
 *   - The **extension** (VS Code): URLs come from settings, tokens from
 *     SecretStorage. It writes the resolved set through to the shared env file
 *     so external agents can use it.
 *   - The **standalone server** (spawned by Codex / Claude Code / Antigravity,
 *     which cannot read VS Code SecretStorage): reads `process.env` first, then
 *     the shared env file.
 *
 * That file lives at `~/.codebrain/atlassian.env` with mode 0600 — it holds
 * personal access tokens, so it must never land in a repo or a world-readable
 * config. Agent config files therefore carry only the command to run, never a
 * token.
 *
 * Deliberately free of `vscode` imports: the standalone server bundle must not
 * pull the extension host in.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Connection details for one Atlassian product. */
export interface AtlassianEndpoint {
  /** Base URL including any context path (for example `https://x/wiki`). */
  baseUrl: string;
  /** Personal access token (Server/DC) or API token (Cloud). */
  token: string;
  /**
   * Set only for Cloud/API-token setups, where auth is Basic `user:token`
   * instead of a `Bearer` personal access token.
   */
  username?: string;
}

export interface AtlassianConnections {
  jira?: AtlassianEndpoint;
  confluence?: AtlassianEndpoint;
}

/** Raw, unvalidated values as they appear in the env file or `process.env`. */
export interface AtlassianEnvValues {
  JIRA_URL?: string;
  JIRA_PERSONAL_TOKEN?: string;
  JIRA_USERNAME?: string;
  CONFLUENCE_URL?: string;
  CONFLUENCE_PERSONAL_TOKEN?: string;
  CONFLUENCE_USERNAME?: string;
}

export const ATLASSIAN_ENV_KEYS = [
  'JIRA_URL',
  'JIRA_PERSONAL_TOKEN',
  'JIRA_USERNAME',
  'CONFLUENCE_URL',
  'CONFLUENCE_PERSONAL_TOKEN',
  'CONFLUENCE_USERNAME',
] as const satisfies readonly (keyof AtlassianEnvValues)[];

/** Keys that must never be logged or echoed back to the user. */
export const ATLASSIAN_SECRET_KEYS = [
  'JIRA_PERSONAL_TOKEN',
  'CONFLUENCE_PERSONAL_TOKEN',
] as const satisfies readonly (keyof AtlassianEnvValues)[];

/**
 * Path of the shared env file. `CODEBRAIN_ATLASSIAN_ENV` overrides it so a
 * team can point every agent at a managed location, and so tests never touch
 * the developer's real home directory.
 */
export function atlassianEnvPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const override = env.CODEBRAIN_ATLASSIAN_ENV?.trim();
  if (override) return override;
  return join(home, '.codebrain', 'atlassian.env');
}

/**
 * Parse a dotenv-shaped file.
 *
 * Supports `KEY=value`, a leading `export `, `#` comments, and single- or
 * double-quoted values (quoted values keep their inner `#` and whitespace).
 * Unknown keys are returned too — the caller decides what it cares about —
 * but malformed lines are skipped rather than throwing, so one bad line never
 * costs the user their whole configuration.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ')
      ? line.slice('export '.length).trim()
      : line;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) continue;

    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    values[key] = unquoteValue(withoutExport.slice(separator + 1).trim());
  }

  return values;
}

function unquoteValue(raw: string): string {
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    const inner = raw.slice(1, -1);
    // Only double quotes carry escapes, matching shell semantics.
    return raw.startsWith('"')
      ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : inner;
  }
  // Unquoted values end at an inline comment.
  const comment = raw.indexOf(' #');
  return (comment === -1 ? raw : raw.slice(0, comment)).trim();
}

/** Render env-file content. Every value is quoted so tokens with `#` survive. */
export function serializeEnvFile(values: AtlassianEnvValues): string {
  const lines = [
    '# CodeBrain — Atlassian (Jira + Confluence/Collab) connection settings.',
    '# Written by the "CodeBrain: Configure Atlassian (Collab + Jira)" command.',
    '# Read by the bundled CodeBrain Atlassian MCP server, so Copilot, Claude',
    '# Code, Codex and Antigravity all share one set of credentials.',
    '# Keep this file private (mode 0600) — it contains personal access tokens.',
    '',
  ];

  for (const key of ATLASSIAN_ENV_KEYS) {
    const value = values[key];
    if (value === undefined || value === '') continue;
    lines.push(`${key}=${quoteEnvValue(value)}`);
  }

  return `${lines.join('\n')}\n`;
}

function quoteEnvValue(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/** Read the env file, returning `{}` when it is missing or unreadable. */
export function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  try {
    return parseEnvFile(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Write the env file atomically with owner-only permissions.
 *
 * The temp file is created 0600 up front so the token is never briefly
 * world-readable, and `chmodSync` runs again after the rename because an
 * already-existing target keeps its own mode on some platforms.
 */
export function writeEnvFile(filePath: string, values: AtlassianEnvValues): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp.${process.pid}`;
  try {
    writeFileSync(temp, serializeEnvFile(values), {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temp, filePath);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The original write failure is the one worth reporting.
    }
    throw error;
  }
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows has no POSIX mode; the file is already user-scoped there.
  }
}

/** Delete the env file. Returns whether a file was actually removed. */
export function deleteEnvFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  rmSync(filePath, { force: true });
  return true;
}

/**
 * Merge env values from the process environment and the env file.
 *
 * `process.env` wins: an explicitly exported variable is a deliberate
 * override (CI, a per-project shell, a second Jira instance), while the file
 * is the persisted default.
 */
export function mergeEnvValues(
  env: NodeJS.ProcessEnv,
  fileValues: Record<string, string>,
): AtlassianEnvValues {
  const merged: AtlassianEnvValues = {};
  for (const key of ATLASSIAN_ENV_KEYS) {
    const value = env[key]?.trim() || fileValues[key]?.trim();
    if (value) merged[key] = value;
  }
  return merged;
}

/**
 * Strip trailing slashes so `baseUrl + '/rest/api/...'` never doubles up.
 * A context path (`/wiki`, `/jira`) is preserved — Confluence Cloud needs it.
 */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** True for an `http`/`https` URL we can actually call. */
export function isUsableBaseUrl(url: string): boolean {
  try {
    const parsed = new URL(normalizeBaseUrl(url));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Turn raw env values into validated endpoints.
 *
 * A product is only usable with both a valid URL and a token, so a
 * half-configured product is dropped here and reported by
 * {@link describeConnectionProblems} instead of failing later inside a tool
 * call with an opaque network error.
 */
export function toConnections(values: AtlassianEnvValues): AtlassianConnections {
  const connections: AtlassianConnections = {};

  if (
    values.JIRA_URL &&
    values.JIRA_PERSONAL_TOKEN &&
    isUsableBaseUrl(values.JIRA_URL)
  ) {
    connections.jira = {
      baseUrl: normalizeBaseUrl(values.JIRA_URL),
      token: values.JIRA_PERSONAL_TOKEN,
      username: values.JIRA_USERNAME,
    };
  }

  if (
    values.CONFLUENCE_URL &&
    values.CONFLUENCE_PERSONAL_TOKEN &&
    isUsableBaseUrl(values.CONFLUENCE_URL)
  ) {
    connections.confluence = {
      baseUrl: normalizeBaseUrl(values.CONFLUENCE_URL),
      token: values.CONFLUENCE_PERSONAL_TOKEN,
      username: values.CONFLUENCE_USERNAME,
    };
  }

  return connections;
}

/**
 * Human-readable reasons a product is unavailable. Empty for a fully
 * configured product and for one the user simply left blank.
 */
export function describeConnectionProblems(values: AtlassianEnvValues): string[] {
  const problems: string[] = [];

  const check = (
    product: string,
    urlKey: 'JIRA_URL' | 'CONFLUENCE_URL',
    tokenKey: 'JIRA_PERSONAL_TOKEN' | 'CONFLUENCE_PERSONAL_TOKEN',
  ): void => {
    const url = values[urlKey];
    const token = values[tokenKey];
    if (!url && !token) return; // Not configured on purpose.
    if (!url) problems.push(`${product}: ${urlKey} is missing.`);
    else if (!isUsableBaseUrl(url))
      problems.push(`${product}: ${urlKey} is not a valid http(s) URL (${url}).`);
    if (!token) problems.push(`${product}: ${tokenKey} is missing.`);
  };

  check('Jira', 'JIRA_URL', 'JIRA_PERSONAL_TOKEN');
  check('Confluence', 'CONFLUENCE_URL', 'CONFLUENCE_PERSONAL_TOKEN');
  return problems;
}

/**
 * Resolve connections the way the standalone MCP server does:
 * `process.env` over the shared env file.
 */
export function resolveConnections(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): {
  values: AtlassianEnvValues;
  connections: AtlassianConnections;
  envFile: string;
} {
  const envFile = atlassianEnvPath(env, home);
  const values = mergeEnvValues(env, readEnvFile(envFile));
  return { values, connections: toConnections(values), envFile };
}

/**
 * Whether TLS verification should be relaxed. Internal Atlassian deployments
 * often sit behind a private CA; opting out is explicit and per-user.
 */
export function sslVerifyDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CODEBRAIN_ATLASSIAN_SSL_VERIFY?.trim().toLowerCase();
  return raw === 'false' || raw === '0' || raw === 'no';
}
