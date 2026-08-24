import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTypeScript } from './helpers/load.mjs';

const { buildTomlTable, removeTomlTable, upsertTomlTable } =
  loadTypeScript('atlassian/toml.ts');
const {
  ATLASSIAN_TARGETS,
  MCP_SERVER_KEY,
  antigravityConfigPath,
  describeTarget,
  installTarget,
  readInstalledEntry,
  removeTarget,
  targetConfigPaths,
} = loadTypeScript('atlassian/targets.ts');

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

test('every declared target has a descriptor', () => {
  for (const target of ATLASSIAN_TARGETS) {
    assert.equal(describeTarget(target.id).displayName, target.displayName);
  }
  assert.throws(() => describeTarget('nope'), /Unknown Atlassian MCP target/);
});

test('Claude Code gets a project-scoped .mcp.json with no secrets in it', () => {
  const paths = sandbox();
  const path = join(paths.workspaceRoot, '.mcp.json');
  writeFileSync(
    path,
    `${JSON.stringify({ mcpServers: { existing: { command: 'keep-me' } } }, null, 2)}\n`,
  );

  const created = installTarget('claude', ENTRY, paths);
  assert.equal(created.action, 'updated');
  assert.equal(created.path, path);

  const config = JSON.parse(read(path));
  assert.equal(config.mcpServers.existing.command, 'keep-me');
  assert.equal(config.mcpServers[MCP_SERVER_KEY].type, 'stdio');
  assert.equal(config.mcpServers[MCP_SERVER_KEY].command, ENTRY.command);
  assert.deepEqual(config.mcpServers[MCP_SERVER_KEY].args, ENTRY.args);
  // The whole point of the shared env file: no token reaches a committed file.
  assert.ok(!read(path).includes('PERSONAL_TOKEN'));

  assert.equal(installTarget('claude', ENTRY, paths).action, 'unchanged');

  const removed = removeTarget('claude', paths);
  assert.equal(removed.action, 'removed');
  const after = JSON.parse(read(path));
  assert.deepEqual(after, { mcpServers: { existing: { command: 'keep-me' } } });
  assert.equal(removeTarget('claude', paths).action, 'not-found');
});

test('Claude Code is skipped, not failed, when no folder is open', () => {
  const { homeDir } = sandbox();
  const result = installTarget('claude', ENTRY, { homeDir });
  assert.equal(result.action, 'skipped');
  assert.match(result.reason, /no folder is open/);
  assert.deepEqual(targetConfigPaths('claude', { homeDir }), []);

  const removal = removeTarget('claude', { homeDir });
  assert.equal(removal.action, 'skipped');
});

test('a greenfield Claude Code install creates the file', () => {
  const paths = sandbox();
  const result = installTarget('claude', ENTRY, paths);
  assert.equal(result.action, 'created');
  assert.equal(JSON.parse(read(result.path)).mcpServers[MCP_SERVER_KEY].command, ENTRY.command);
});

test('Codex keeps its other settings and drops the section on removal', () => {
  const paths = sandbox();
  const path = join(paths.homeDir, '.codex', 'config.toml');
  mkdirSync(join(paths.homeDir, '.codex'), { recursive: true });
  writeFileSync(path, 'model = "gpt-5"\n\n[mcp_servers.codegraph]\ncommand = "codegraph"\n');

  const created = installTarget('codex', ENTRY, paths);
  assert.equal(created.action, 'updated');
  assert.ok(read(path).includes(`[mcp_servers.${MCP_SERVER_KEY}]`));
  assert.ok(read(path).includes('[mcp_servers.codegraph]'));
  assert.ok(read(path).includes('model = "gpt-5"'));

  assert.equal(installTarget('codex', ENTRY, paths).action, 'unchanged');

  const removed = removeTarget('codex', paths);
  assert.equal(removed.action, 'removed');
  assert.ok(!read(path).includes(MCP_SERVER_KEY));
  assert.ok(read(path).includes('[mcp_servers.codegraph]'));
});

test('Codex install writes an env table only when one is supplied', () => {
  const paths = sandbox();
  const path = join(paths.homeDir, '.codex', 'config.toml');

  installTarget('codex', ENTRY, paths);
  assert.ok(!read(path).includes('env ='));

  installTarget('codex', { ...ENTRY, env: { CODEBRAIN_ATLASSIAN_MAX_RESULTS: '25' } }, paths);
  assert.ok(read(path).includes('env = { CODEBRAIN_ATLASSIAN_MAX_RESULTS = "25" }'));
});

test('Antigravity writes the legacy path until the migration marker appears', () => {
  const paths = sandbox();
  const legacy = join(paths.homeDir, '.gemini', 'antigravity', 'mcp_config.json');
  const unified = join(paths.homeDir, '.gemini', 'config', 'mcp_config.json');

  assert.equal(antigravityConfigPath(paths), legacy);
  const created = installTarget('antigravity', ENTRY, paths);
  assert.equal(created.path, legacy);
  // Antigravity rejects entries that carry `type: "stdio"`.
  const entry = JSON.parse(read(legacy)).mcpServers[MCP_SERVER_KEY];
  assert.equal(entry.type, undefined);
  assert.equal(entry.command, ENTRY.command);

  mkdirSync(join(paths.homeDir, '.gemini', 'config'), { recursive: true });
  writeFileSync(join(paths.homeDir, '.gemini', 'config', '.migrated'), '');
  assert.equal(antigravityConfigPath(paths), unified);
  assert.equal(installTarget('antigravity', ENTRY, paths).path, unified);

  // Removal sweeps both, so a migrated user is not left with a stale entry.
  const removed = removeTarget('antigravity', paths);
  assert.equal(removed.action, 'removed');
  assert.equal(removed.paths.length, 2);
  assert.deepEqual(JSON.parse(read(legacy)), {});
  assert.deepEqual(JSON.parse(read(unified)), {});
});

test('an unparseable JSON config is backed up before being rebuilt', () => {
  const paths = sandbox();
  const path = join(paths.workspaceRoot, '.mcp.json');
  writeFileSync(path, '{ "mcpServers": { broken');

  installTarget('claude', ENTRY, paths);
  assert.equal(read(`${path}.backup`), '{ "mcpServers": { broken');
  assert.equal(JSON.parse(read(path)).mcpServers[MCP_SERVER_KEY].command, ENTRY.command);
});

test('readInstalledEntry finds a stale path so an upgrade can repair it', () => {
  const paths = sandbox();
  const stale = { command: '/ext/codebrain-1.1.0/node', args: ['/ext/codebrain-1.1.0/dist/atlassian-server.js'] };

  installTarget('claude', stale, paths);
  installTarget('codex', stale, paths);

  assert.equal(readInstalledEntry('claude', paths).entry.command, stale.command);
  const codexEntry = readInstalledEntry('codex', paths).entry;
  assert.equal(codexEntry.command, stale.command);
  assert.deepEqual(codexEntry.args, stale.args);

  assert.equal(readInstalledEntry('antigravity', paths), undefined);

  installTarget('codex', ENTRY, paths);
  assert.deepEqual(readInstalledEntry('codex', paths).entry.args, ENTRY.args);
});

test('readInstalledEntry survives a Windows-shaped command with backslashes', () => {
  const paths = sandbox();
  const windows = {
    command: 'C:\\Users\\me\\.vscode\\extensions\\codebrain\\runtime\\node.exe',
    args: ['C:\\Users\\me\\.vscode\\extensions\\codebrain\\dist\\atlassian-server.js'],
  };
  installTarget('codex', windows, paths);
  assert.deepEqual(readInstalledEntry('codex', paths).entry, windows);
});
