import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTypeScript } from './helpers/load.mjs';

// The registrar writes under the real home directory; point it at a sandbox.
const home = mkdtempSync(join(tmpdir(), 'codebrain-registrar-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const vscode = { workspace: { workspaceFolders: undefined, getWorkspaceFolder: () => undefined }, window: {} };
const { McpRegistrar } = loadTypeScript('agents/registration.ts', { vscode });
const { parseSkill } = loadTypeScript('agents/skillFormat.ts');

const skills = [
  parseSkill('---\nname: codebrain\ndescription: Use CodeBrain.\n---\n\n# CodeBrain\n', 'codebrain'),
  parseSkill('---\nname: codebrain-fix\ndescription: Fix bugs.\n---\n\n# Fix\n', 'codebrain-fix'),
];

function fakeExtra(calls) {
  return {
    id: 'hook',
    label: '$(zap) Hook',
    detail: 'test',
    targets: ['claude'],
    describe: () => '~/.claude/settings.json',
    install: (id, _paths, scope) => {
      calls.push(['install', id, scope]);
      return { displayName: 'Claude Code', action: 'created' };
    },
    remove: (id) => {
      calls.push(['remove', id]);
      return { action: 'removed', paths: ['x'] };
    },
    refresh: () => [],
  };
}

test('one registrar installs its MCP entry, every skill and its extras for the chosen agents', () => {
  const calls = [];
  const logs = [];
  const registrar = new McpRegistrar({
    serverKey: 'codebrain',
    label: 'CodeBrain',
    entry: () => ({ command: '/node', args: ['serve'] }),
    skills: () => skills,
    extras: [fakeExtra(calls)],
    log: (line) => logs.push(line),
  });

  const offered = registrar.offeredTargets('global');
  const claude = offered.find((target) => target.id === 'claude');
  assert.ok(claude.details.some((detail) => detail.startsWith('CodeBrain MCP:')));
  assert.ok(claude.details.some((detail) => detail.includes('+1 workflow skills')));
  assert.ok(claude.details.includes('Hook: ~/.claude/settings.json'), 'the codicon is dropped from the label');
  assert.ok(!offered.find((target) => target.id === 'codex').details.some((d) => d.startsWith('Hook')));

  const result = registrar.installAll(['claude', 'codex'], 'global');
  assert.deepEqual(result.skipped, []);
  assert.ok(existsSync(join(home, '.claude', 'skills', 'codebrain-fix', 'SKILL.md')));
  assert.ok(existsSync(join(home, '.agents', 'skills', 'codebrain', 'SKILL.md')));
  assert.match(readFileSync(join(home, '.claude.json'), 'utf8'), /"codebrain"/);
  assert.deepEqual(calls, [['install', 'claude', 'global']], 'extras only for agents that support them');

  const removed = registrar.removeAll();
  assert.ok(removed.includes('Claude Code (skills)'));
  assert.ok(removed.includes('Claude Code (hook)'));
  assert.ok(!existsSync(join(home, '.claude', 'skills', 'codebrain-fix', 'SKILL.md')));
  assert.doesNotMatch(readFileSync(join(home, '.claude.json'), 'utf8'), /"codebrain"/);
});

test('a project-scoped install with no folder open is reported as skipped, not thrown', () => {
  const registrar = new McpRegistrar({
    serverKey: 'codebrain',
    label: 'CodeBrain',
    entry: () => ({ command: '/node', args: [] }),
    skills: () => skills,
    log: () => {},
  });
  const result = registrar.installAll(['cursor'], 'project');
  assert.ok(result.skipped.length > 0);
  assert.ok(result.skipped.every((line) => line.startsWith('Cursor')));
});
