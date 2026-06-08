/**
 * VS Code target.
 *
 * Writes:
 *   - MCP server entry to `.vscode/mcp.json` (local) or the VS Code
 *     user-profile `mcp.json` (global), using the documented
 *     `servers.codegraph` shape.
 *   - Agent Skill to `.github/skills/codegraph/SKILL.md` (local) or
 *     `~/.copilot/skills/codegraph/SKILL.md` (global). The frontmatter
 *     `name` must match the parent folder: `codegraph`.
 *   - Local custom agent to `.github/agents/codegraph.agent.md`.
 *
 * No permissions concept. VS Code handles MCP trust/tool confirmation in
 * its own UI.
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
  atomicWriteFileSync,
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';

type VscodeMcpConfig = { type: string; command: string; args: string[] };

export const VSCODE_CODEGRAPH_SKILL = [
  '---',
  'name: codegraph',
  'description: Use CodeGraph MCP tools when working in VS Code on codebase exploration, architecture questions, symbol lookup, callers/callees, impact analysis before edits, debugging, refactoring plans, PR review, or index freshness checks.',
  '---',
  '',
  '# CodeGraph Skill',
  '',
  'You are a code-intelligence assistant powered by the CodeGraph knowledge graph. Use the indexed graph before broad file reading when the user asks how code works, where something lives, what calls what, what a change might break, or why a behavior fails.',
  '',
  '## Always Do',
  '',
  '- Check `codegraph_status` when freshness matters, when results look stale, or before a risky change.',
  '- Prefer one `codegraph_explore` call for architecture, flow, debugging, and "how does X work" questions.',
  '- Run `codegraph_impact` before editing any function, class, method, exported API, route handler, shared component, or public type.',
  '- Report direct callers/dependents first; these are the items most likely to break.',
  '- Read exact source files only after CodeGraph narrows the target area, or when a staleness banner says a referenced file changed since the last sync.',
  '- Validate code changes with the repo\'s compiler, tests, linter, or focused command after editing.',
  '',
  '## Never Do',
  '',
  '- Do not grep/read-loop first for symbol discovery; use `codegraph_search` or `codegraph_explore`.',
  '- Do not edit a non-trivial symbol without first checking impact.',
  '- Do not ignore stale-index warnings. If CodeGraph reports pending files, read those files directly or refresh the index.',
  '- Do not treat CodeGraph as a test runner. It explains structure and relationships; compilers and tests validate behavior.',
  '- Do not invent unavailable tools such as GitNexus `rename`, `detect_changes`, Cypher, repo registry, groups, or process URI resources.',
  '',
  '## Tool Selection',
  '',
  '| Intent | Use |',
  '| --- | --- |',
  '| Understand an area, architecture, bug, route, or flow | `codegraph_explore` |',
  '| Locate a symbol/file quickly | `codegraph_search` |',
  '| Inspect one exact symbol body, especially ambiguous overloads | `codegraph_node` with code included |',
  '| See what calls a symbol | `codegraph_callers` |',
  '| See what a symbol calls | `codegraph_callees` |',
  '| Estimate blast radius before edits | `codegraph_impact` |',
  '| Browse indexed files or a directory | `codegraph_files` |',
  '| Check initialized/fresh/stale/index stats | `codegraph_status` |',
  '',
  '## Workflows',
  '',
  '### Explore Or Explain',
  '',
  '```',
  '1. codegraph_status if the answer depends on recent edits',
  '2. codegraph_explore({ query: "<question or symbols>" })',
  '3. codegraph_node only if one returned symbol needs deeper source',
  '4. Read exact files only for implementation details not covered by CodeGraph',
  '```',
  '',
  'Use this for "How does X work?", "Show me the auth flow", "Where is database logic?", "How does X reach Y?", and onboarding questions.',
  '',
  '### Impact Before Editing',
  '',
  '```',
  '1. codegraph_search({ query: "<symbol/file>" }) if the target is ambiguous',
  '2. codegraph_impact({ query/target: "<symbol>" })',
  '3. Review direct dependents first',
  '4. Warn clearly if the change touches critical paths or many dependents',
  '5. Edit only after the risk is understood',
  '6. Run focused validation commands',
  '```',
  '',
  'Risk guide:',
  '',
  '| Signal | Risk |',
  '| --- | --- |',
  '| Few direct dependents, local-only behavior | LOW |',
  '| Several dependents or multiple feature areas | MEDIUM |',
  '| Many dependents, exported/public API, route/auth/payment/data paths | HIGH |',
  '| Critical path plus stale index or unclear ownership | CRITICAL |',
  '',
  '### Debug',
  '',
  '```',
  '1. Capture the symptom: error text, endpoint, command, UI action, or wrong value',
  '2. codegraph_explore({ query: "<symptom and likely area>" })',
  '3. codegraph_callers or codegraph_callees on suspect symbols',
  '4. codegraph_impact if the fix changes shared behavior',
  '5. Read the narrowed files and apply the smallest fix',
  '6. Run the failing or nearest validation command',
  '```',
  '',
  'Patterns:',
  '',
  '| Symptom | CodeGraph approach |',
  '| --- | --- |',
  '| Error message | `codegraph_explore` for the error/throw path |',
  '| Wrong return value | `codegraph_callees` on the producer and validator |',
  '| Unexpected caller | `codegraph_callers` on the side-effecting symbol |',
  '| Regression after edits | `codegraph_impact` on changed shared symbols |',
  '| Missing route/entry point | `codegraph_search` then `codegraph_explore` |',
  '',
  '### Refactor',
  '',
  '```',
  '1. codegraph_search to find the exact symbol(s)',
  '2. codegraph_impact before changing signatures, exports, names, or file boundaries',
  '3. codegraph_callers/codegraph_callees to plan update order',
  '4. Edit interfaces/types first, then implementations, then callers, then tests',
  '5. Run focused tests/compiler/linter',
  '6. Re-check impact or callers if the refactor changed the target surface',
  '```',
  '',
  'For renames, do not use blind find-and-replace. Use language tooling or scoped edits after CodeGraph identifies definitions and callers.',
  '',
  '### PR Review',
  '',
  '```',
  '1. Inspect changed files',
  '2. codegraph_status for freshness',
  '3. codegraph_explore on touched areas',
  '4. codegraph_impact on modified shared symbols',
  '5. Report findings first, ordered by severity',
  '6. Call out missing tests or stale-index uncertainty',
  '```',
  '',
  '## Output Discipline',
  '',
  '- Lead with the answer or finding, then cite the CodeGraph evidence used.',
  '- For impact reports, separate direct dependents from indirect or possible effects.',
  '- For debug, distinguish confirmed root cause from plausible suspect.',
  '- For refactors, name the update order and validation command.',
  '- If CodeGraph is not initialized, tell the user to initialize/sync the workspace instead of falling back to a large grep pass.',
  '',
  '## Self-Check Before Finishing',
  '',
  '```',
  '- [ ] Used CodeGraph before broad manual exploration',
  '- [ ] Checked freshness when relevant',
  '- [ ] Ran impact before non-trivial edits',
  '- [ ] Read stale or edited files directly when needed',
  '- [ ] Ran or reported validation',
  '- [ ] Did not reference retired GitNexus-only tools or group/registry context',
  '```',
  '',
].join('\n');

export const VSCODE_CODEGRAPH_AGENT = [
  '---',
  'name: codegraph',
  'description: >',
  '  CodeGraph code-intelligence agent for the current VS Code workspace.',
  '  Use this agent for architecture exploration, impact analysis, debugging,',
  '  PR review, and safe refactoring tasks that should query CodeGraph first.',
  'tools:',
  '  - codegraph/*',
  '  - codebrain_editFiles',
  '---',
  '',
  '# CodeGraph Agent',
  '',
  'You are a code-intelligence assistant powered by the CodeGraph knowledge graph for the current VS Code workspace. Help developers understand code, assess blast radius, trace bugs, review changes, and refactor safely.',
  '',
  '## Always Do',
  '',
  '- **MUST check index freshness** with `codegraph_status` when results may depend on recent edits, before risky changes, or when CodeGraph reports stale/pending files.',
  '- **MUST run impact analysis before editing non-trivial symbols.** Call `codegraph_impact` before modifying a function, class, method, exported API, route handler, shared component, or public type. Report direct dependents first.',
  '- **MUST warn the user** before proceeding when impact suggests HIGH/CRITICAL risk, critical paths, or unclear ownership.',
  '- Use `codegraph_explore` before broad manual reading for architecture, flow, debugging, and "how does this work" questions.',
  '- Use `codegraph_search` to locate exact symbols/files when the target is ambiguous.',
  '- Validate edits with the closest compiler, test, lint, or focused command. If validation is not possible, say why.',
  '',
  '## When Debugging',
  '',
  '1. `codegraph_explore({ query: "<error, symptom, endpoint, command, or likely area>" })` to find relevant code and flow.',
  '2. `codegraph_callers` or `codegraph_callees` on suspect symbols to inspect control/data paths.',
  '3. `codegraph_impact` before changing shared behavior.',
  '4. Read only the narrowed files, especially any file named in a stale-index banner.',
  '5. Apply the smallest targeted fix and run the nearest validation.',
  '',
  '## When Refactoring',
  '',
  '- Run `codegraph_search` to identify the exact definition(s).',
  '- Run `codegraph_impact` before changing signatures, exports, names, file boundaries, or shared behavior.',
  '- Use `codegraph_callers` and `codegraph_callees` to plan update order: interfaces/types, implementations, callers, tests.',
  '- For renames, do not use blind find-and-replace. Use language tooling or scoped edits after CodeGraph identifies definitions and callers.',
  '- After refactoring, rerun focused validation and re-check callers/impact if the public surface changed.',
  '',
  '## When Reviewing Changes',
  '',
  '1. Inspect the changed files and summarize the review scope.',
  '2. Run `codegraph_status` to catch stale index issues.',
  '3. Use `codegraph_explore` on touched areas.',
  '4. Use `codegraph_impact` on modified shared symbols.',
  '5. Report findings first, ordered by severity, with missing tests or stale-index uncertainty called out.',
  '',
  '## Never Do',
  '',
  '- NEVER edit a non-trivial function, class, method, exported API, route handler, shared component, or public type without first checking `codegraph_impact`.',
  '- NEVER ignore stale-index warnings; read pending files directly or refresh the index.',
  '- NEVER use retired GitNexus-only tools such as `gitnexus_detect_changes`, `gitnexus_rename`, `gitnexus_context`, Cypher, repo registry, groups, or process URI resources.',
  '- NEVER treat CodeGraph as a replacement for tests, compiler checks, lint, or runtime validation.',
  '- NEVER do broad grep/read loops before trying `codegraph_explore` or `codegraph_search`.',
  '',
  '## Self-Check Before Finishing',
  '',
  '1. `codegraph_status` was checked when freshness mattered.',
  '2. `codegraph_impact` was run for every non-trivial modified symbol.',
  '3. Direct dependents/callers were considered and reported.',
  '4. No HIGH/CRITICAL risk or stale-index warning was ignored.',
  '5. Edited files were validated, or the validation gap was reported.',
  '',
].join('\n');

function vscodeUserDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
  }

  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(xdg, 'Code', 'User');
}

function mcpJsonPath(loc: Location): string {
  return loc === 'global'
    ? path.join(vscodeUserDir(), 'mcp.json')
    : path.join(process.cwd(), '.vscode', 'mcp.json');
}

function skillPath(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.copilot', 'skills', 'codegraph', 'SKILL.md')
    : path.join(process.cwd(), '.github', 'skills', 'codegraph', 'SKILL.md');
}

function agentPath(loc: Location): string | undefined {
  return loc === 'local'
    ? path.join(process.cwd(), '.github', 'agents', 'codegraph.agent.md')
    : undefined;
}

function buildVscodeMcpConfig(): VscodeMcpConfig {
  return {
    type: 'stdio',
    command: 'codegraph',
    args: ['serve', '--mcp', '--path', '${workspaceFolder}'],
  };
}

class VscodeTarget implements AgentTarget {
  readonly id = 'vscode' as const;
  readonly displayName = 'VS Code';
  readonly docsUrl = 'https://code.visualstudio.com/docs/agent-customization/mcp-servers';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.servers?.codegraph;
    const localAgentPath = agentPath(loc);
    const installed = loc === 'global'
      ? alreadyConfigured ||
        fs.existsSync(path.dirname(file)) ||
        fs.existsSync(path.join(os.homedir(), '.vscode')) ||
        fs.existsSync(skillPath(loc)) ||
        Boolean(process.env.VSCODE_PID)
      : alreadyConfigured ||
        fs.existsSync(path.join(process.cwd(), '.vscode')) ||
        fs.existsSync(path.join(process.cwd(), '.github')) ||
        fs.existsSync(skillPath(loc)) ||
        Boolean(localAgentPath && fs.existsSync(localAgentPath));

    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [
      writeMcpEntry(loc),
      writeSkillFile(loc),
    ];
    if (loc === 'local') {
      files.push(writeAgentFile(loc));
    }

    return {
      files,
      notes: ['Use MCP: List Servers in VS Code to start or refresh the CodeGraph server.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [
      removeMcpEntry(loc),
      removeSkillFile(loc),
    ];
    if (loc === 'local') {
      files.push(removeAgentFile(loc));
    }

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ servers: { codegraph: buildVscodeMcpConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [
      mcpJsonPath(loc),
      skillPath(loc),
      ...(agentPath(loc) ? [agentPath(loc)!] : []),
    ];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existing = readJsonFile(file);
  const before = existing.servers?.codegraph;
  const after = buildVscodeMcpConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  const action: 'created' | 'updated' =
    before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.servers) existing.servers = {};
  existing.servers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

function removeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const config = readJsonFile(file);
  if (!config.servers?.codegraph) {
    return { path: file, action: 'not-found' };
  }

  delete config.servers.codegraph;
  if (Object.keys(config.servers).length === 0) {
    delete config.servers;
  }
  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

function writeSkillFile(loc: Location): WriteResult['files'][number] {
  const file = skillPath(loc);
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf-8');
    if (existing === VSCODE_CODEGRAPH_SKILL) {
      return { path: file, action: 'unchanged' };
    }
  }

  const action: 'created' | 'updated' = fs.existsSync(file) ? 'updated' : 'created';
  atomicWriteFileSync(file, VSCODE_CODEGRAPH_SKILL);
  return { path: file, action };
}

function removeSkillFile(loc: Location): WriteResult['files'][number] {
  const file = skillPath(loc);
  if (!fs.existsSync(file)) {
    return { path: file, action: 'not-found' };
  }

  try {
    fs.unlinkSync(file);
    removeEmptyDir(path.dirname(file));
  } catch {
    return { path: file, action: 'kept' };
  }

  return { path: file, action: 'removed' };
}

function writeAgentFile(loc: Location): WriteResult['files'][number] {
  const file = agentPath(loc);
  if (!file) {
    return { path: '', action: 'not-found' };
  }

  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf-8');
    if (existing === VSCODE_CODEGRAPH_AGENT) {
      return { path: file, action: 'unchanged' };
    }
  }

  const action: 'created' | 'updated' = fs.existsSync(file) ? 'updated' : 'created';
  atomicWriteFileSync(file, VSCODE_CODEGRAPH_AGENT);
  return { path: file, action };
}

function removeAgentFile(loc: Location): WriteResult['files'][number] {
  const file = agentPath(loc);
  if (!file || !fs.existsSync(file)) {
    return { path: file ?? '', action: 'not-found' };
  }

  try {
    fs.unlinkSync(file);
    removeEmptyDir(path.dirname(file));
  } catch {
    return { path: file, action: 'kept' };
  }

  return { path: file, action: 'removed' };
}

function removeEmptyDir(dir: string): void {
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {
    // Best effort cleanup only.
  }
}

export const vscodeTarget: AgentTarget = new VscodeTarget();
