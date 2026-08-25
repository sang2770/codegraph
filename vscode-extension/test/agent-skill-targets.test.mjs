import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTypeScript } from './helpers/load.mjs';

const { readMarkdownBlock, removeMarkdownBlock, upsertMarkdownBlock } =
  loadTypeScript('agents/markdownBlock.ts');
const {
  SKILL_BLOCK_END,
  SKILL_BLOCK_START,
  SKILL_TARGET_IDS,
  describeSkillTargets,
  installSkill,
  isSkillStale,
  loadSkill,
  parseSkill,
  readInstalledSkills,
  removeSkill,
  renderSkill,
  skillArtifacts,
  skillTargetDisplayName,
} = loadTypeScript('agents/skillTargets.ts');

const SOURCE = `---
name: codebrain
description: Use CodeBrain for fast code understanding.
argument-hint: "[question]"
user-invocable: true
---

# CodeBrain

Query \`codegraph_explore\` before grep.

1. Start with the business purpose.
2. Trace the ordered steps.
`;

const SKILL = parseSkill(SOURCE, 'codebrain');

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'codebrain-skill-'));
  const homeDir = join(root, 'home');
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  return { homeDir, workspaceRoot };
}

const read = (path) => readFileSync(path, 'utf8');

// ---------------------------------------------------------- markdown blocks

test('a marked block is inserted, replaced, then reported unchanged', () => {
  const start = '<!-- S -->';
  const end = '<!-- E -->';

  const inserted = upsertMarkdownBlock('# My notes\n\nkeep me\n', start, end, 'body');
  assert.equal(inserted.action, 'inserted');
  assert.ok(inserted.content.startsWith('# My notes\n\nkeep me'));
  assert.ok(inserted.content.includes(`${start}\nbody\n${end}`));

  assert.equal(upsertMarkdownBlock(inserted.content, start, end, 'body').action, 'unchanged');

  const replaced = upsertMarkdownBlock(inserted.content, start, end, 'next');
  assert.equal(replaced.action, 'replaced');
  assert.ok(replaced.content.includes('next'));
  assert.ok(!replaced.content.includes('\nbody\n'));
  assert.ok(replaced.content.includes('keep me'));

  assert.equal(readMarkdownBlock(replaced.content, start, end), `${start}\nnext\n${end}`);

  const removed = removeMarkdownBlock(replaced.content, start, end);
  assert.equal(removed.action, 'removed');
  assert.equal(removed.content, '# My notes\n\nkeep me\n');
  assert.equal(removeMarkdownBlock(removed.content, start, end).action, 'not-found');
});

test('an unterminated marker is appended past, not overwritten', () => {
  // A hand-edited file we cannot safely rewrite: the user's text below the
  // opening marker must survive, so a fresh block is appended instead.
  const broken = '<!-- S -->\nsomething the user wrote\n';
  const result = upsertMarkdownBlock(broken, '<!-- S -->', '<!-- E -->', 'body');
  assert.equal(result.action, 'inserted');
  assert.ok(result.content.includes('something the user wrote'));
  assert.ok(result.content.includes('<!-- E -->'));
  assert.equal(readMarkdownBlock(broken, '<!-- S -->', '<!-- E -->'), undefined);
});

// ----------------------------------------------------------------- parsing

test('SKILL.md is split into the pieces each agent format needs', () => {
  assert.equal(SKILL.name, 'codebrain');
  assert.equal(SKILL.title, 'CodeBrain');
  assert.equal(SKILL.description, 'Use CodeBrain for fast code understanding.');
  // Claude Code reads the file as-is, so the frontmatter has to survive.
  assert.ok(SKILL.source.startsWith('---\nname: codebrain'));
  // The body is what the other formats embed, without the frontmatter.
  assert.ok(!SKILL.body.includes('user-invocable'));
  assert.ok(SKILL.body.startsWith('# CodeBrain'));

  // A file with no frontmatter still yields something usable.
  const bare = parseSkill('# Title\n\nbody', 'fallback');
  assert.equal(bare.name, 'fallback');
  assert.equal(bare.title, 'Title');
  assert.equal(bare.description, '');
});

test('the skill shipped with the extension parses', () => {
  const shipped = loadSkill(new URL('..', import.meta.url).pathname);
  assert.equal(shipped.name, 'codebrain');
  assert.ok(shipped.description.length > 0);
  assert.ok(shipped.body.includes('codegraph_explore'));
});

// -------------------------------------------------------------- descriptors

test('each scope offers the agents that actually have somewhere to put it', () => {
  const global = describeSkillTargets(SKILL, 'global');
  assert.deepEqual(
    global.filter((target) => target.supported).map((target) => target.id),
    ['claude', 'codex', 'gemini', 'antigravity'],
  );
  // Copilot's instructions file belongs to the repository, so global is wrong.
  assert.match(global.find((target) => target.id === 'copilot').detail, /workspace scope/);

  const project = describeSkillTargets(SKILL, 'project');
  assert.deepEqual(
    project.filter((target) => target.supported).map((target) => target.id),
    ['claude', 'gemini', 'copilot'],
  );
  for (const id of ['codex', 'antigravity']) {
    assert.match(project.find((target) => target.id === id).detail, /install it globally/);
  }

  for (const id of SKILL_TARGET_IDS) {
    assert.equal(typeof skillTargetDisplayName(id), 'string');
  }
});

// ---------------------------------------------------------------- installs

test('Claude Code gets the skill file verbatim, at either scope', () => {
  const paths = sandbox();

  const created = installSkill(SKILL, 'claude', paths, 'global');
  assert.equal(created.action, 'created');
  assert.equal(created.path, join(paths.homeDir, '.claude', 'skills', 'codebrain', 'SKILL.md'));
  // Frontmatter and all: Claude Code's skill format is the one we author in.
  assert.equal(read(created.path), `${SOURCE.trim()}\n`);

  assert.equal(installSkill(SKILL, 'claude', paths, 'global').action, 'unchanged');

  const project = installSkill(SKILL, 'claude', paths, 'project');
  assert.equal(project.action, 'created');
  assert.equal(
    project.path,
    join(paths.workspaceRoot, '.claude', 'skills', 'codebrain', 'SKILL.md'),
  );

  // Uninstall with no scope sweeps both.
  const removed = removeSkill(SKILL, 'claude', paths);
  assert.equal(removed.action, 'removed');
  assert.equal(removed.paths.length, 2);
  assert.equal(existsSync(created.path), false);
  assert.equal(existsSync(project.path), false);
  assert.equal(removeSkill(SKILL, 'claude', paths).action, 'not-found');
});

test('Codex gets a prompt file, Gemini a TOML command', () => {
  const paths = sandbox();

  const codex = installSkill(SKILL, 'codex', paths, 'global');
  assert.equal(codex.path, join(paths.homeDir, '.codex', 'prompts', 'codebrain.md'));
  const prompt = read(codex.path);
  assert.ok(prompt.startsWith(SKILL.description));
  assert.ok(prompt.includes('codegraph_explore'));
  // A prompt file is the whole prompt — no frontmatter to leak into it.
  assert.ok(!prompt.includes('user-invocable'));

  const gemini = installSkill(SKILL, 'gemini', paths, 'global');
  assert.equal(gemini.path, join(paths.homeDir, '.gemini', 'commands', 'codebrain.toml'));
  const toml = read(gemini.path);
  assert.ok(toml.startsWith('description = "Use CodeBrain for fast code understanding."'));
  // A literal string keeps the backticks and quotes in the body intact.
  assert.ok(toml.includes("prompt = '''"));
  assert.ok(toml.includes('`codegraph_explore`'));

  assert.equal(installSkill(SKILL, 'gemini', paths, 'global').action, 'unchanged');
  assert.equal(removeSkill(SKILL, 'gemini', paths).action, 'removed');
  assert.equal(existsSync(gemini.path), false);
});

test('a body containing triple quotes falls back to an escaped TOML string', () => {
  const awkward = parseSkill("---\nname: x\ndescription: d\n---\n\n# X\n\nhas ''' inside", 'x');
  const toml = renderSkill('gemini', awkward);
  assert.ok(toml.includes('prompt = """'));
  assert.ok(toml.includes("has ''' inside"));
});

test('Antigravity and Copilot get a marked block that leaves the file alone', () => {
  const paths = sandbox();
  const gemini = join(paths.homeDir, '.gemini', 'GEMINI.md');
  mkdirSync(join(paths.homeDir, '.gemini'), { recursive: true });
  writeFileSync(gemini, '# My instructions\n\nAlways answer in Vietnamese.\n');

  const written = installSkill(SKILL, 'antigravity', paths, 'global');
  assert.equal(written.action, 'updated');
  assert.equal(written.path, gemini);

  const content = read(gemini);
  assert.ok(content.startsWith('# My instructions\n\nAlways answer in Vietnamese.'));
  assert.ok(content.includes(SKILL_BLOCK_START));
  assert.ok(content.includes(SKILL_BLOCK_END));
  // The block demotes the skill's own `#` heading so it nests under the file.
  assert.ok(content.includes('## CodeBrain'));
  assert.ok(!content.includes('\n# CodeBrain\n'));

  assert.equal(installSkill(SKILL, 'antigravity', paths, 'global').action, 'unchanged');

  const copilot = installSkill(SKILL, 'copilot', paths, 'project');
  assert.equal(copilot.action, 'created');
  assert.equal(
    copilot.path,
    join(paths.workspaceRoot, '.github', 'copilot-instructions.md'),
  );

  // Removal takes the block out and leaves the user's own instructions.
  assert.equal(removeSkill(SKILL, 'antigravity', paths).action, 'removed');
  assert.equal(read(gemini), '# My instructions\n\nAlways answer in Vietnamese.\n');
  assert.equal(existsSync(gemini), true);
});

test('an agent with no config at the chosen scope is skipped with a reason', () => {
  const paths = sandbox();

  for (const id of ['codex', 'antigravity']) {
    const result = installSkill(SKILL, id, paths, 'project');
    assert.equal(result.action, 'skipped');
    assert.match(result.reason, /install it globally/);
    assert.deepEqual(skillArtifacts(id, SKILL, paths, 'project'), []);
  }

  const copilot = installSkill(SKILL, 'copilot', paths, 'global');
  assert.equal(copilot.action, 'skipped');
  assert.match(copilot.reason, /install it for the workspace/);

  // Project scope with no folder open has nowhere to write.
  const homeOnly = { homeDir: paths.homeDir };
  const claude = installSkill(SKILL, 'claude', homeOnly, 'project');
  assert.equal(claude.action, 'skipped');
  assert.match(claude.reason, /no folder is open/);
});

// ----------------------------------------------------------------- refresh

test('an installed skill is detected as stale once the extension ships new text', () => {
  const paths = sandbox();
  installSkill(SKILL, 'claude', paths, 'global');
  installSkill(SKILL, 'gemini', paths, 'project');
  installSkill(SKILL, 'antigravity', paths, 'global');

  const next = parseSkill(SOURCE.replace('before grep', 'before any search'), 'codebrain');

  for (const id of ['claude', 'gemini', 'antigravity']) {
    const installed = readInstalledSkills(SKILL, id, paths);
    assert.equal(installed.length, 1, `${id} holds one copy`);
    assert.equal(isSkillStale(installed[0], SKILL, id), false, `${id} is current`);
    assert.equal(isSkillStale(installed[0], next, id), true, `${id} went stale`);

    // Re-installing at the recorded scope brings it back in line.
    const refreshed = installSkill(next, id, paths, installed[0].artifact.scope);
    assert.equal(refreshed.action, 'updated');
    assert.equal(isSkillStale(readInstalledSkills(next, id, paths)[0], next, id), false);
  }

  // An agent that never opted in is left alone.
  assert.deepEqual(readInstalledSkills(SKILL, 'codex', paths), []);
});
