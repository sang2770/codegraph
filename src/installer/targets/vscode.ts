/**
 * GitHub Copilot in VS Code target (`vscode`). Writes the MCP server entry to:
 *
 *   - global → `mcp.json` in the VS Code user profile folder
 *     (`~/Library/Application Support/Code/User/` on macOS,
 *     `%APPDATA%\Code\User\` on Windows, `$XDG_CONFIG_HOME/Code/User/`
 *     — default `~/.config/Code/User/` — on Linux).
 *   - local  → `./.vscode/mcp.json`.
 *
 * Distinct from the Copilot CLI target: VS Code does NOT read
 * `~/.copilot/mcp-config.json` or `.github/mcp.json`, and its file uses the
 * top-level `servers` key, not `mcpServers` (the CLI in turn ignores
 * `.vscode/mcp.json`). The two targets therefore never share a file.
 *
 * No `--path` arg (unlike Cursor): VS Code starts a stdio server in the
 * workspace folder and answers MCP `roots/list`, so the server finds the
 * project on its own and the same entry works in every workspace.
 *
 * `mcp.json` is JSONC and is often hand-edited next to `inputs`, so edits are
 * surgical via `jsonc-parser` — comments, formatting and sibling servers
 * survive install / re-install / uninstall.
 *
 * No instructions file: Copilot Chat receives the MCP `initialize`
 * instructions, and `.github/copilot-instructions.md` belongs to the Copilot
 * CLI target.
 *
 * Docs: https://code.visualstudio.com/docs/copilot/reference/mcp-configuration
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseJsonc, modify, applyEdits, type ParseError } from 'jsonc-parser';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  getMcpServerConfig,
  jsonDeepEqual,
  resolveReviewTool,
} from './shared';

const FORMATTING = { tabSize: 2, insertSpaces: true, eol: '\n' };

function userDataDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'Code', 'User');
}

function mcpJsonPath(loc: Location): string {
  return loc === 'global'
    ? path.join(userDataDir(), 'mcp.json')
    : path.join(process.cwd(), '.vscode', 'mcp.json');
}

/**
 * Parsed config plus the text to edit. An unparseable file is backed up to
 * `<path>.backup` and replaced by an empty object — `modify` on broken JSONC
 * could otherwise splice our entry into the middle of the damage.
 */
function readConfig(file: string): { text: string; config: Record<string, any> } {
  if (!fs.existsSync(file)) return { text: '', config: {} };
  const text = fs.readFileSync(file, 'utf-8');
  if (!text.trim()) return { text: '', config: {} };
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`  Warning: Could not parse ${file}; a backup will be created before overwriting.`);
    try { fs.copyFileSync(file, file + '.backup'); } catch { /* ignore backup failure */ }
    return { text: '', config: {} };
  }
  return { text, config: parsed as Record<string, any> };
}

class VsCodeTarget implements AgentTarget {
  readonly id = 'vscode' as const;
  readonly displayName = 'GitHub Copilot (VS Code)';
  readonly docsUrl = 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const { config } = readConfig(file);
    const alreadyConfigured = !!config.servers?.codegraph;
    // The user profile folder is the "VS Code is here" signal for both
    // locations — nearly every repo has a `.vscode/`, so it says nothing.
    const installed = fs.existsSync(userDataDir()) || fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    return {
      files: [writeMcpEntry(loc, opts.reviewTool)],
      notes: ['Reload the VS Code window, then pick the codegraph tools in Copilot Chat (Agent mode).'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const file = mcpJsonPath(loc);
    if (!fs.existsSync(file)) return { files: [{ path: file, action: 'not-found' }] };
    const { text, config } = readConfig(file);
    if (!config.servers?.codegraph) return { files: [{ path: file, action: 'not-found' }] };

    let updated = applyEdits(text, modify(text, ['servers', 'codegraph'], undefined, { formattingOptions: FORMATTING }));
    const after = parseJsonc(updated) as Record<string, any>;
    if (after.servers && typeof after.servers === 'object' && Object.keys(after.servers).length === 0) {
      updated = applyEdits(updated, modify(updated, ['servers'], undefined, { formattingOptions: FORMATTING }));
    }
    // The file is left in place even when empty: it may hold `inputs`, and it
    // can sit in a committed `.vscode/`.
    atomicWriteFileSync(file, updated);
    return { files: [{ path: file, action: 'removed' }] };
  }

  printConfig(loc: Location): string {
    const snippet = JSON.stringify({ servers: { codegraph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${mcpJsonPath(loc)}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc)];
  }
}

function writeMcpEntry(loc: Location, reviewTool?: boolean): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existed = fs.existsSync(file);
  const { text, config } = readConfig(file);
  const before = config.servers?.codegraph;
  const after = getMcpServerConfig(resolveReviewTool(reviewTool, before?.args));

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const base = text.trim() ? text : '{}\n';
  const updated = applyEdits(base, modify(base, ['servers', 'codegraph'], after, { formattingOptions: FORMATTING }));
  atomicWriteFileSync(file, updated.endsWith('\n') ? updated : updated + '\n');
  return { path: file, action: existed ? 'updated' : 'created' };
}

export const vscodeTarget: AgentTarget = new VsCodeTarget();
