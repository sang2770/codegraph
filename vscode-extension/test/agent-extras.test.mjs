import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from './helpers/load.mjs';

const {
  installPromptHook,
  isPromptHookCommand,
  promptHookCommand,
  readInstalledPromptHooks,
  refreshPromptHooks,
  removePromptHook,
} = loadTypeScript('agents/promptHookTargets.ts');
const {
  installSubagents,
  loadSubagents,
  parseAgentFile,
  removeSubagents,
  renderSubagent,
  staleSubagentScopes,
  subagentPath,
} = loadTypeScript('agents/subagentTargets.ts');

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'codebrain-extras-'));
  const homeDir = join(root, 'home');
  const workspaceRoot = join(root, 'ws');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  return { homeDir, workspaceRoot };
}
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const ENTRY = { command: '/opt/node v1/bin/node', args: ['/ext/codebrain-1.0.0/dist/atlassian-server.js'] };
const NEXT = { command: '/opt/node v1/bin/node', args: ['/ext/codebrain-1.1.0/dist/atlassian-server.js'] };

// ----------------------------------------------------------- prompt hook

test('the hook command is quoted, slash-normalised and recognisable', () => {
  const command = promptHookCommand({ command: 'C:\\Program Files\\node.exe', args: ['C:\\ext\\dist\\atlassian-server.js'] });
  assert.equal(command, '"C:/Program Files/node.exe" "C:/ext/dist/atlassian-server.js" --prompt-hook');
  assert.ok(isPromptHookCommand(command));
  assert.ok(!isPromptHookCommand('codegraph prompt-hook'));
  assert.ok(!isPromptHookCommand('node /x/atlassian-server.js'));
});

test('installing the hook keeps sibling hooks and settings, and is idempotent', () => {
  const paths = sandbox();
  const file = join(paths.homeDir, '.claude', 'settings.json');
  mkdirSync(join(paths.homeDir, '.claude'), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      model: 'sonnet',
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codegraph prompt-hook' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      },
    }),
  );

  assert.equal(installPromptHook(ENTRY, paths, 'global').action, 'updated');
  const settings = readJson(file);
  assert.equal(settings.model, 'sonnet');
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'say done');
  assert.equal(settings.hooks.UserPromptSubmit.length, 2);
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, 'codegraph prompt-hook');
  assert.equal(settings.hooks.UserPromptSubmit[1].hooks[0].command, promptHookCommand(ENTRY));
  assert.equal(settings.hooks.UserPromptSubmit[1].hooks[0].timeout, 15);

  const before = readFileSync(file, 'utf8');
  assert.equal(installPromptHook(ENTRY, paths, 'global').action, 'unchanged');
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('an upgrade repoints the hook in place instead of adding a second one', () => {
  const paths = sandbox();
  installPromptHook(ENTRY, paths, 'project');
  assert.deepEqual(refreshPromptHooks(ENTRY, paths), []);
  const results = refreshPromptHooks(NEXT, paths);
  assert.deepEqual(results.map((result) => [result.scope, result.action]), [['project', 'updated']]);
  const installed = readInstalledPromptHooks(paths);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].command, promptHookCommand(NEXT));
  // A user who never installed the hook is never given one by a refresh.
  assert.deepEqual(refreshPromptHooks(NEXT, sandbox()), []);
});

test('a settings file that is not JSON is refused, never rebuilt', () => {
  const paths = sandbox();
  const file = join(paths.homeDir, '.claude', 'settings.json');
  mkdirSync(join(paths.homeDir, '.claude'), { recursive: true });
  writeFileSync(file, '{ "model": "sonnet", // comment\n}');
  const result = installPromptHook(ENTRY, paths, 'global');
  assert.equal(result.action, 'skipped');
  assert.match(result.reason, /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{ "model": "sonnet", // comment\n}');
  assert.equal(installPromptHook(ENTRY, { homeDir: paths.homeDir }, 'project').action, 'skipped');
});

test('removing the hook reverses the install and leaves the rest alone', () => {
  const paths = sandbox();
  const file = join(paths.homeDir, '.claude', 'settings.json');
  mkdirSync(join(paths.homeDir, '.claude'), { recursive: true });
  writeFileSync(file, JSON.stringify({ model: 'sonnet' }));
  installPromptHook(ENTRY, paths, 'global');
  installPromptHook(ENTRY, paths, 'project');

  const result = removePromptHook(paths);
  assert.equal(result.action, 'removed');
  assert.equal(result.paths.length, 2);
  assert.deepEqual(readJson(file), { model: 'sonnet' });
  assert.equal(removePromptHook(paths).action, 'not-found');
});

// ------------------------------------------------------------- subagents

test('the shipped agent files parse into host-neutral roles', () => {
  const agents = loadSubagents(fileURLToPath(new URL('..', import.meta.url)));
  assert.deepEqual(agents.map((agent) => [agent.name, agent.readOnly]), [
    ['codebrain-dev', false],
    ['codebrain-reviewer', true],
  ]);
  for (const agent of agents) {
    assert.ok(agent.description.length > 40);
    assert.ok(agent.body.includes('codegraph_'));
    assert.ok(!agent.body.startsWith('---'));
    assert.doesNotMatch(agent.body, /`problems`/, 'bodies avoid Copilot-only tool names');
  }
});

const DEV = parseAgentFile('---\nname: CodeBrain Dev\ndescription: Builds things: carefully.\ntools: [edit]\n---\n\nDo work.\n', 'codebrain-dev.agent.md', false);
const REVIEWER = parseAgentFile('---\ndescription: Reviews only\n---\nLook.', 'codebrain-reviewer.agent.md', true);

test('each host gets its own frontmatter; read-only roles lose edit tools', () => {
  assert.equal(renderSubagent('claude', DEV), '---\nname: codebrain-dev\ndescription: "Builds things: carefully."\n---\n\nDo work.\n');
  const claudeReviewer = renderSubagent('claude', REVIEWER);
  assert.match(claudeReviewer, /^tools: Read, Grep, Glob, mcp__codebrain__codegraph_explore/m);
  assert.doesNotMatch(claudeReviewer, /\bEdit\b|\bBash\b|\bWrite\b/);
  assert.equal(renderSubagent('opencode', DEV), '---\ndescription: "Builds things: carefully."\nmode: subagent\n---\n\nDo work.\n');
  assert.match(renderSubagent('opencode', REVIEWER), /tools:\n  write: false\n  edit: false\n  bash: false/);
});

test('subagents install, stay unchanged, go stale, and uninstall per host', () => {
  const paths = sandbox();
  assert.deepEqual(staleSubagentScopes([DEV, REVIEWER], 'claude', paths), []);

  const first = installSubagents([DEV, REVIEWER], 'claude', paths, 'global');
  assert.equal(first.action, 'created');
  assert.ok(existsSync(join(paths.homeDir, '.claude', 'agents', 'codebrain-dev.md')));
  assert.equal(installSubagents([DEV, REVIEWER], 'claude', paths, 'global').action, 'unchanged');

  installSubagents([DEV], 'opencode', paths, 'project');
  assert.equal(subagentPath('opencode', DEV, paths, 'project'), join(paths.workspaceRoot, '.opencode', 'agent', 'codebrain-dev.md'));
  // opencode has Dev only: the Reviewer role is missing, so the scope is stale.
  assert.deepEqual(staleSubagentScopes([DEV, REVIEWER], 'opencode', paths), ['project']);

  const changed = { ...DEV, body: 'Do better work.' };
  assert.deepEqual(staleSubagentScopes([changed, REVIEWER], 'claude', paths), ['global']);
  assert.equal(installSubagents([changed, REVIEWER], 'claude', paths, 'global').action, 'updated');

  const removed = removeSubagents([DEV, REVIEWER], 'claude', paths);
  assert.equal(removed.action, 'removed');
  assert.equal(removed.paths.length, 2);
  assert.ok(existsSync(join(paths.workspaceRoot, '.opencode', 'agent', 'codebrain-dev.md')), 'other hosts untouched');
  assert.equal(installSubagents([DEV], 'claude', { homeDir: paths.homeDir }, 'project').action, 'skipped');
});
