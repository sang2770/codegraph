import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTypeScript } from './helpers/load.mjs';

const { buildTomlTable, removeTomlTable, upsertTomlTable } =
  loadTypeScript('agents/toml.ts');
const {
  AGENT_TARGET_IDS,
  MCP_SCOPES,
  antigravityConfigPath,
  describeTarget,
  describeTargets,
  installTarget,
  isEntryStale,
  readInstalledEntries,
  removeTarget,
  targetConfigFiles,
  targetDisplayName,
  targetWriteFile,
} = loadTypeScript('agents/mcpTargets.ts');

// The Atlassian server's key: the bodies below were written against it, and it
// exercises the same code path every other server key takes. A second key is
// covered explicitly at the end of the file.
const MCP_SERVER_KEY = 'codebrain-atlassian';

// Thin adapters so each test reads as "install this target" rather than
// repeating the server key on every line. Scope defaults to global, the only
// one three of the four agents have.
const install = (id, entry, paths, scope = 'global') =>
  installTarget(MCP_SERVER_KEY, id, entry, paths, scope);
const uninstall = (id, paths, scope) => removeTarget(MCP_SERVER_KEY, id, paths, scope);
const installedEntries = (id, paths) => readInstalledEntries(MCP_SERVER_KEY, id, paths);
const soleEntry = (id, paths) => {
  const found = installedEntries(id, paths);
  assert.equal(found.length, 1, `${id} holds exactly one entry`);
  return found[0].entry;
};

const ENTRY = {
  command: '/ext/codebrain-1.2.0/runtime/linux-x64/node',
  args: ['/ext/codebrain-1.2.0/dist/atlassian-server.js'],
};

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'codebrain-targets-'));
  const homeDir = join(root, 'home');
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  return { homeDir, workspaceRoot };
}

function read(path) {
  return readFileSync(path, 'utf8');
}

// ------------------------------------------------------------------- TOML

test('TOML table is inserted, replaced, then reported unchanged', () => {
  const header = `mcp_servers.${MCP_SERVER_KEY}`;
  const block = buildTomlTable(header, { command: 'node', args: ['server.js'] });

  const inserted = upsertTomlTable('', header, block);
  assert.equal(inserted.action, 'inserted');
  assert.equal(inserted.content, `${block}\n`);

  const unchanged = upsertTomlTable(inserted.content, header, block);
  assert.equal(unchanged.action, 'unchanged');
  assert.equal(unchanged.content, inserted.content);

  const next = buildTomlTable(header, { command: 'node2', args: ['server.js'] });
  const replaced = upsertTomlTable(inserted.content, header, next);
  assert.equal(replaced.action, 'replaced');
  assert.ok(replaced.content.includes('node2'));
  assert.ok(!replaced.content.includes('"node"'));
});

test('sibling tables, arrays of tables and multiline strings survive a round-trip', () => {
  const header = `mcp_servers.${MCP_SERVER_KEY}`;
  const original = [
    'model = "gpt-5"',
    '',
    '[mcp_servers.other]',
    'command = "other-server"',
    'note = """',
    '[not.a.table]',
    '"""',
    '',
    '[[profiles]]',
    'name = "work"',
    'paths = [',
    '  "a",',
    '  "b",',
    ']',
    '',
  ].join('\n');

  const block = buildTomlTable(header, { command: 'node', args: ['server.js'] });
  const installed = upsertTomlTable(original, header, block);
  assert.equal(installed.action, 'inserted');
  for (const fragment of ['[mcp_servers.other]', '[not.a.table]', '[[profiles]]', 'paths = [']) {
    assert.ok(installed.content.includes(fragment), `lost ${fragment}`);
  }

  const removed = removeTomlTable(installed.content, header);
  assert.equal(removed.action, 'removed');
  assert.equal(`${removed.content.trimEnd()}\n`, original.trimEnd() + '\n');
  assert.equal(removeTomlTable(removed.content, header).action, 'not-found');
});

test('TOML values escape quotes and backslashes', () => {
  const block = buildTomlTable('t', {
    command: 'C:\\Program Files\\node.exe',
    args: ['say "hi"'],
    env: { KEY: 'a"b' },
  });
  assert.ok(block.includes('"C:\\\\Program Files\\\\node.exe"'));
  assert.ok(block.includes('["say \\"hi\\""]'));
  assert.ok(block.includes('env = { KEY = "a\\"b" }'));
});

// ---------------------------------------------------------------- targets

test('every target is described at both scopes, and only some support project', () => {
  for (const scope of MCP_SCOPES) {
    const targets = describeTargets(MCP_SERVER_KEY, scope);
    assert.deepEqual(
      targets.map((target) => target.id),
      [...AGENT_TARGET_IDS],
      `${scope} lists every agent`,
    );
    for (const target of targets) {
      assert.equal(
        describeTarget(MCP_SERVER_KEY, target.id, scope).displayName,
        target.displayName,
      );
      assert.equal(targetDisplayName(target.id), target.displayName);
    }
  }

  // Codex and Antigravity have no project-scoped MCP config at all, so the
  // picker must not offer them there.
  const project = describeTargets(MCP_SERVER_KEY, 'project');
  assert.deepEqual(
    project.filter((target) => target.supported).map((target) => target.id),
    ['claude', 'gemini'],
  );
  for (const id of ['codex', 'antigravity']) {
    const target = project.find((entry) => entry.id === id);
    assert.match(target.detail, /register it globally/);
  }
  assert.equal(
    describeTargets(MCP_SERVER_KEY, 'global').every((target) => target.supported),
    true,
  );

  // The Codex line names the TOML table, so it has to follow the server key.
  const codex = describeTargets(MCP_SERVER_KEY, 'global').find((t) => t.id === 'codex');
  assert.ok(codex.detail.includes(`[mcp_servers.${MCP_SERVER_KEY}]`));
  assert.throws(() => describeTarget(MCP_SERVER_KEY, 'nope', 'global'), /Unknown MCP target/);
});

test('Claude Code project scope writes .mcp.json with no secrets in it', () => {
  const paths = sandbox();
  const path = join(paths.workspaceRoot, '.mcp.json');
  writeFileSync(
    path,
    `${JSON.stringify({ mcpServers: { existing: { command: 'keep-me' } } }, null, 2)}\n`,
  );

  const created = install('claude', ENTRY, paths, 'project');
  assert.equal(created.action, 'updated');
  assert.equal(created.path, path);
  assert.equal(created.scope, 'project');

  const config = JSON.parse(read(path));
  assert.equal(config.mcpServers.existing.command, 'keep-me');
  assert.equal(config.mcpServers[MCP_SERVER_KEY].type, 'stdio');
  assert.equal(config.mcpServers[MCP_SERVER_KEY].command, ENTRY.command);
  assert.deepEqual(config.mcpServers[MCP_SERVER_KEY].args, ENTRY.args);
  // The whole point of the shared env file: no token reaches a committed file.
  assert.ok(!read(path).includes('PERSONAL_TOKEN'));

  assert.equal(install('claude', ENTRY, paths, 'project').action, 'unchanged');

  const removed = uninstall('claude', paths, 'project');
  assert.equal(removed.action, 'removed');
  const after = JSON.parse(read(path));
  assert.deepEqual(after, { mcpServers: { existing: { command: 'keep-me' } } });
  assert.equal(uninstall('claude', paths, 'project').action, 'not-found');
});

test('Claude Code global scope writes ~/.claude.json and leaves its state alone', () => {
  const paths = sandbox();
  const path = join(paths.homeDir, '.claude.json');
  // ~/.claude.json is Claude Code's own state file, not ours to manage.
  writeFileSync(
    path,
    `${JSON.stringify({ numStartups: 42, projects: { '/repo': { history: [] } } }, null, 2)}\n`,
  );

  const result = install('claude', ENTRY, paths, 'global');
  assert.equal(result.path, path);
  assert.equal(result.action, 'updated');

  const config = JSON.parse(read(path));
  assert.equal(config.numStartups, 42);
  assert.deepEqual(config.projects, { '/repo': { history: [] } });
  assert.equal(config.mcpServers[MCP_SERVER_KEY].command, ENTRY.command);

  // The two scopes are separate files: a global install leaves the project one
  // untouched, and vice versa.
  assert.equal(installedEntries('claude', paths).length, 1);
  install('claude', ENTRY, paths, 'project');
  assert.deepEqual(
    installedEntries('claude', paths).map((found) => found.file.scope),
    ['global', 'project'],
  );

  // Unregister without a scope sweeps both, so nothing is left behind.
  const removed = uninstall('claude', paths);
  assert.equal(removed.action, 'removed');
  assert.equal(removed.paths.length, 2);
  assert.deepEqual(installedEntries('claude', paths), []);
  assert.equal(JSON.parse(read(path)).numStartups, 42);
});

test('a project-scoped install is skipped, not failed, when no folder is open', () => {
  const { homeDir } = sandbox();

  for (const id of ['claude', 'gemini']) {
    const result = install(id, ENTRY, { homeDir }, 'project');
    assert.equal(result.action, 'skipped');
    assert.match(result.reason, /no folder is open/);
    assert.deepEqual(targetConfigFiles(id, { homeDir }, 'project'), []);
    assert.equal(targetWriteFile(id, { homeDir }, 'project'), undefined);
  }

  assert.equal(uninstall('claude', { homeDir }, 'project').action, 'skipped');
});

test('Codex and Antigravity refuse project scope instead of writing a dead file', () => {
  const paths = sandbox();

  for (const id of ['codex', 'antigravity']) {
    const result = install(id, ENTRY, paths, 'project');
    assert.equal(result.action, 'skipped');
    assert.match(result.reason, /no project-scoped MCP config/);
    assert.deepEqual(targetConfigFiles(id, paths, 'project'), []);

    const removal = uninstall(id, paths, 'project');
    assert.equal(removal.action, 'skipped');
  }
});

test('a greenfield Claude Code install creates the file', () => {
  const paths = sandbox();
  const result = install('claude', ENTRY, paths, 'project');
  assert.equal(result.action, 'created');
  assert.equal(JSON.parse(read(result.path)).mcpServers[MCP_SERVER_KEY].command, ENTRY.command);
});

test('Codex keeps its other settings and drops the section on removal', () => {
  const paths = sandbox();
  const path = join(paths.homeDir, '.codex', 'config.toml');
  mkdirSync(join(paths.homeDir, '.codex'), { recursive: true });
  writeFileSync(path, 'model = "gpt-5"\n\n[mcp_servers.codegraph]\ncommand = "codegraph"\n');

  const created = install('codex', ENTRY, paths);
  assert.equal(created.action, 'updated');
  assert.ok(read(path).includes(`[mcp_servers.${MCP_SERVER_KEY}]`));
  assert.ok(read(path).includes('[mcp_servers.codegraph]'));
  assert.ok(read(path).includes('model = "gpt-5"'));

  assert.equal(install('codex', ENTRY, paths).action, 'unchanged');

  const removed = uninstall('codex', paths);
  assert.equal(removed.action, 'removed');
  assert.ok(!read(path).includes(MCP_SERVER_KEY));
  assert.ok(read(path).includes('[mcp_servers.codegraph]'));
});

test('Codex install writes an env table only when one is supplied', () => {
  const paths = sandbox();
  const path = join(paths.homeDir, '.codex', 'config.toml');

  install('codex', ENTRY, paths);
  assert.ok(!read(path).includes('env ='));

  install('codex', { ...ENTRY, env: { CODEBRAIN_ATLASSIAN_MAX_RESULTS: '25' } }, paths);
  assert.ok(read(path).includes('env = { CODEBRAIN_ATLASSIAN_MAX_RESULTS = "25" }'));
});

test('Gemini CLI gets settings.json at both scopes, beside its other settings', () => {
  const paths = sandbox();
  const global = join(paths.homeDir, '.gemini', 'settings.json');
  mkdirSync(join(paths.homeDir, '.gemini'), { recursive: true });
  writeFileSync(
    global,
    `${JSON.stringify({ theme: 'Default', mcpServers: { other: { command: 'keep-me' } } }, null, 2)}\n`,
  );

  const updated = install('gemini', ENTRY, paths);
  assert.equal(updated.action, 'updated');
  assert.equal(updated.path, global);

  const config = JSON.parse(read(global));
  assert.equal(config.theme, 'Default');
  assert.equal(config.mcpServers.other.command, 'keep-me');
  assert.equal(config.mcpServers[MCP_SERVER_KEY].command, ENTRY.command);
  // Gemini's own schema has no `type`, and no `trust` means it keeps asking
  // before running a tool — that stays the user's call.
  assert.equal(config.mcpServers[MCP_SERVER_KEY].type, undefined);
  assert.equal(config.mcpServers[MCP_SERVER_KEY].trust, undefined);

  assert.equal(install('gemini', ENTRY, paths).action, 'unchanged');

  const project = install('gemini', ENTRY, paths, 'project');
  assert.equal(project.action, 'created');
  assert.equal(project.path, join(paths.workspaceRoot, '.gemini', 'settings.json'));

  assert.equal(uninstall('gemini', paths).action, 'removed');
  assert.deepEqual(JSON.parse(read(global)), {
    theme: 'Default',
    mcpServers: { other: { command: 'keep-me' } },
  });
  assert.deepEqual(installedEntries('gemini', paths), []);
});

test('Antigravity writes the legacy path until the migration marker appears', () => {
  const paths = sandbox();
  const legacy = join(paths.homeDir, '.gemini', 'antigravity', 'mcp_config.json');
  const unified = join(paths.homeDir, '.gemini', 'config', 'mcp_config.json');

  assert.equal(antigravityConfigPath(paths), legacy);
  const created = install('antigravity', ENTRY, paths);
  assert.equal(created.path, legacy);
  // Antigravity rejects entries that carry `type: "stdio"`.
  const entry = JSON.parse(read(legacy)).mcpServers[MCP_SERVER_KEY];
  assert.equal(entry.type, undefined);
  assert.equal(entry.command, ENTRY.command);

  mkdirSync(join(paths.homeDir, '.gemini', 'config'), { recursive: true });
  writeFileSync(join(paths.homeDir, '.gemini', 'config', '.migrated'), '');
  assert.equal(antigravityConfigPath(paths), unified);
  assert.equal(install('antigravity', ENTRY, paths).path, unified);

  // Removal sweeps both, so a migrated user is not left with a stale entry.
  const removed = uninstall('antigravity', paths);
  assert.equal(removed.action, 'removed');
  assert.equal(removed.paths.length, 2);
  assert.deepEqual(JSON.parse(read(legacy)), {});
  assert.deepEqual(JSON.parse(read(unified)), {});
});

test('an unparseable JSON config is backed up before being rebuilt', () => {
  const paths = sandbox();
  const path = join(paths.workspaceRoot, '.mcp.json');
  writeFileSync(path, '{ "mcpServers": { broken');

  install('claude', ENTRY, paths, 'project');
  assert.equal(read(`${path}.backup`), '{ "mcpServers": { broken');
  assert.equal(JSON.parse(read(path)).mcpServers[MCP_SERVER_KEY].command, ENTRY.command);
});

test('readInstalledEntries finds a stale path at either scope so an upgrade can repair it', () => {
  const paths = sandbox();
  const stale = {
    command: '/ext/codebrain-1.1.0/node',
    args: ['/ext/codebrain-1.1.0/dist/atlassian-server.js'],
  };

  install('claude', stale, paths, 'project');
  install('gemini', stale, paths, 'global');
  install('codex', stale, paths);

  assert.equal(soleEntry('claude', paths).command, stale.command);
  assert.equal(installedEntries('claude', paths)[0].file.scope, 'project');
  assert.equal(soleEntry('gemini', paths).command, stale.command);

  const codexEntry = soleEntry('codex', paths);
  assert.equal(codexEntry.command, stale.command);
  assert.deepEqual(codexEntry.args, stale.args);

  assert.deepEqual(installedEntries('antigravity', paths), []);

  install('codex', ENTRY, paths);
  assert.deepEqual(soleEntry('codex', paths).args, ENTRY.args);
});

test('readInstalledEntries survives a Windows-shaped command with backslashes', () => {
  const paths = sandbox();
  const windows = {
    command: 'C:\\Users\\me\\.vscode\\extensions\\codebrain\\runtime\\node.exe',
    args: ['C:\\Users\\me\\.vscode\\extensions\\codebrain\\dist\\atlassian-server.js'],
  };
  install('codex', windows, paths);
  assert.deepEqual(soleEntry('codex', paths), windows);
});

// ------------------------------------------------- more than one server key

const CODEBRAIN_KEY = 'codebrain';
const GRAPH_ENTRY = {
  command: '/ext/codebrain-1.2.0/runtime/linux-x64/node',
  args: ['--liftoff-only', '/ext/codebrain-1.2.0/lib/dist/bin/codegraph.js', 'serve', '--mcp'],
  env: { CODEGRAPH_WATCH_DEBOUNCE_MS: '1000' },
};

test('two servers live side by side in every target, and remove one at a time', () => {
  const paths = sandbox();

  for (const id of AGENT_TARGET_IDS) {
    installTarget(MCP_SERVER_KEY, id, ENTRY, paths, 'global');
    installTarget(CODEBRAIN_KEY, id, GRAPH_ENTRY, paths, 'global');
  }

  const claudeConfig = JSON.parse(read(join(paths.homeDir, '.claude.json')));
  assert.deepEqual(Object.keys(claudeConfig.mcpServers).sort(), [CODEBRAIN_KEY, MCP_SERVER_KEY]);
  assert.deepEqual(claudeConfig.mcpServers[CODEBRAIN_KEY].args, GRAPH_ENTRY.args);

  const codex = read(join(paths.homeDir, '.codex', 'config.toml'));
  assert.ok(codex.includes(`[mcp_servers.${MCP_SERVER_KEY}]`));
  assert.ok(codex.includes(`[mcp_servers.${CODEBRAIN_KEY}]`));
  assert.ok(codex.includes('env = { CODEGRAPH_WATCH_DEBOUNCE_MS = "1000" }'));

  // Removing one server must leave the other one registered everywhere.
  for (const id of AGENT_TARGET_IDS) {
    assert.equal(removeTarget(CODEBRAIN_KEY, id, paths).action, 'removed');
    assert.equal(readInstalledEntries(MCP_SERVER_KEY, id, paths).length, 1, `${id} kept Atlassian`);
    assert.deepEqual(readInstalledEntries(CODEBRAIN_KEY, id, paths), []);
  }

  // `codebrain` is a prefix of `codebrain-atlassian`: a sloppy TOML match would
  // have taken the wrong table above, so assert the survivor is intact.
  const codexAfter = read(join(paths.homeDir, '.codex', 'config.toml'));
  assert.ok(codexAfter.includes(`[mcp_servers.${MCP_SERVER_KEY}]`));
  assert.ok(!codexAfter.includes(`[mcp_servers.${CODEBRAIN_KEY}]`));
});

test('an entry is stale only when the command or its arguments moved', () => {
  assert.equal(isEntryStale(GRAPH_ENTRY, GRAPH_ENTRY), false);
  // env drift alone is not worth rewriting four config files over.
  assert.equal(isEntryStale({ ...GRAPH_ENTRY, env: {} }, GRAPH_ENTRY), false);

  const previous = {
    command: '/ext/codebrain-1.1.0/runtime/linux-x64/node',
    args: GRAPH_ENTRY.args,
  };
  assert.equal(isEntryStale(previous, GRAPH_ENTRY), true);
  // The version lives in the argument list too — a bare command check misses
  // an entrypoint that moved under an unchanged runtime path.
  assert.equal(
    isEntryStale({ command: GRAPH_ENTRY.command, args: ['serve', '--mcp'] }, GRAPH_ENTRY),
    true,
  );
});
