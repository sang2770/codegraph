/**
 * GitHub Copilot CLI target (`copilot`). Writes:
 *
 *   - MCP server entry to `~/.copilot/mcp-config.json` (global) or
 *     `./.github/mcp.json` (local) under the standard
 *     `mcpServers.codegraph` key — same JSON shape as Claude / Cursor /
 *     Gemini / Kiro.
 *   - Instructions to `~/.copilot/copilot-instructions.md` (global) or
 *     `./.github/copilot-instructions.md` (local).
 *
 * Two path choices worth spelling out:
 *
 *   1. **Local goes to `.github/mcp.json`, not `./.mcp.json`.** Copilot
 *      CLI reads both, but `./.mcp.json` is the file the Claude Code
 *      target owns — two targets writing the same `mcpServers.codegraph`
 *      entry means uninstalling one silently breaks the other. GitHub's
 *      docs call `.github/mcp.json` the shared, committed project config,
 *      so it's both correct and collision-free.
 *   2. **`type: 'stdio'`, not `'local'`.** Copilot CLI accepts both and
 *      treats them identically; `stdio` is the standard MCP protocol name
 *      and keeps the entry copy-pasteable into every other client, so we
 *      reuse `getMcpServerConfig()` verbatim.
 *
 * `$COPILOT_HOME` relocates the whole config dir (same as Hermes'
 * `$HERMES_HOME`), so we honor it for the global location.
 *
 * No permissions concept in the config file — Copilot CLI gates tool
 * calls at runtime through `--allow-tool` / `--deny-tool` and its own
 * approval prompts, not an on-disk allowlist. `autoAllow` therefore only
 * changes the note we print (the `--allow-tool='codegraph'` hint), never
 * a file.
 *
 * Docs: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
 *       https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  removeMarkedSection,
  writeJsonFile,
  upsertInstructionsEntry,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

function globalConfigDir(): string {
  return process.env.COPILOT_HOME
    ? path.resolve(process.env.COPILOT_HOME)
    : path.join(os.homedir(), '.copilot');
}
function localConfigDir(): string {
  return path.join(process.cwd(), '.github');
}
function configDir(loc: Location): string {
  return loc === 'global' ? globalConfigDir() : localConfigDir();
}
function mcpJsonPath(loc: Location): string {
  // global → ~/.copilot/mcp-config.json (user scope, every workspace).
  // local  → ./.github/mcp.json (project scope, committed alongside the
  // repo; see header for why not ./.mcp.json).
  return loc === 'global'
    ? path.join(globalConfigDir(), 'mcp-config.json')
    : path.join(localConfigDir(), 'mcp.json');
}
function instructionsPath(loc: Location): string {
  return path.join(configDir(loc), 'copilot-instructions.md');
}

class CopilotCliTarget implements AgentTarget {
  readonly id = 'copilot' as const;
  readonly displayName = 'GitHub Copilot CLI';
  readonly docsUrl =
    'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    // Copilot CLI is a global install, so `~/.copilot/` is the real
    // "is it here" signal for BOTH locations — a project-local
    // `.github/` says nothing about whether the CLI exists (nearly
    // every repo has one), so we don't treat it as a marker.
    const installed = fs.existsSync(globalConfigDir()) || fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));

    // copilot-instructions.md gets the short marker-fenced CodeGraph
    // block (#704): Copilot CLI's own subagents and non-MCP reads never
    // see the MCP initialize instructions. Upsert self-heals a stale
    // pre-#529 block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    const notes = ['Restart Copilot CLI for MCP changes to take effect.'];
    if (opts.autoAllow) {
      // Copilot CLI has no on-disk allowlist — the server-scoped
      // equivalent of Claude's `mcp__codegraph__*` permission is this
      // launch flag, so we hand the user the exact string.
      notes.push(
        "Copilot CLI approves tools at launch, not in config: run `copilot --allow-tool='codegraph'` to skip per-call prompts.",
      );
    }
    return { files, notes };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      // An empty `{}` is left in place rather than deleted — the file
      // may hold (or later hold) other Copilot config, and removing a
      // file inside the user's committed `.github/` would be surprising.
      writeJsonFile(file, config);
      files.push({ path: file, action: 'removed' });
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    files.push(removeInstructionsEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' =
    before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

/**
 * Strip the marker-delimited CodeGraph block from
 * `copilot-instructions.md` if a prior install wrote one. Used by both
 * install (self-heal on upgrade) and uninstall — see issue #529.
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const copilotTarget: AgentTarget = new CopilotCliTarget();
