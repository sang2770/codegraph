import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // `fileURLToPath`, not `.pathname`: on Windows a file URL's pathname is
  // `/D:/a/repo/`, and joining that onto anything resolves against the current
  // drive to `D:\D:\a\repo\…`. It only looks correct on POSIX.
  const shipped = loadSkill(fileURLToPath(new URL('..', import.meta.url)));
  assert.equal(shipped.name, 'codebrain');
  assert.ok(shipped.description.length > 0);
  assert.ok(shipped.body.includes('codegraph_explore'));
});

// -------------------------------------------------------------- descriptors

test('every agent takes a native skill at both scopes', () => {
  for (const scope of ['global', 'project']) {
    const targets = describeSkillTargets(SKILL, scope);
    assert.deepEqual(
      targets.map((target) => target.id),
      ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'opencode'],
    );
    assert.ok(targets.every((target) => target.supported), `${scope}: all supported`);
    assert.ok(targets.every((target) => target.detail.includes('/codebrain/SKILL.md')));
  }

  for (const id of SKILL_TARGET_IDS) {
    assert.equal(typeof skillTargetDisplayName(id), 'string');
  }
});

// ---------------------------------------------------------------- installs

const NATIVE_PATHS = {
  claude: { global: ['.claude', 'skills'], project: ['.claude', 'skills'] },
  codex: { global: ['.agents', 'skills'], project: ['.agents', 'skills'] },
  gemini: { global: ['.gemini', 'skills'], project: ['.gemini', 'skills'] },
  antigravity: { global: ['.gemini', 'config', 'skills'], project: ['.agents', 'skills'] },
  copilot: { global: ['.copilot', 'skills'], project: ['.github', 'skills'] },
  cursor: { global: ['.cursor', 'skills'], project: ['.cursor', 'skills'] },
  opencode: { global: ['.config', 'opencode', 'skills'], project: ['.opencode', 'skills'] },
};

test('each agent gets SKILL.md in its own skills directory, at either scope', () => {
  for (const id of SKILL_TARGET_IDS) {
    const paths = sandbox();
    for (const scope of ['global', 'project']) {
      const base = scope === 'global' ? paths.homeDir : paths.workspaceRoot;
      const result = installSkill(SKILL, id, paths, scope);
      assert.equal(result.action, 'created', `${id} ${scope}`);
      assert.equal(result.path, join(base, ...NATIVE_PATHS[id][scope], 'codebrain', 'SKILL.md'));
      assert.equal(installSkill(SKILL, id, paths, scope).action, 'unchanged', `${id} ${scope} rerun`);
    }

    const removed = removeSkill(SKILL, id, paths);
    assert.equal(removed.action, 'removed', id);
    for (const path of removed.paths) assert.equal(existsSync(path), false);
    // The skill's own folder goes with it; the skills directory stays.
    assert.equal(existsSync(join(paths.homeDir, ...NATIVE_PATHS[id].global, 'codebrain')), false);
    assert.equal(existsSync(join(paths.homeDir, ...NATIVE_PATHS[id].global)), true);
    assert.equal(removeSkill(SKILL, id, paths).action, 'not-found', `${id} second removal`);
  }
});

test('Claude Code gets the file verbatim; the others get standard frontmatter only', () => {
  // Frontmatter and all: Claude Code's skill format is the one we author in.
  assert.equal(renderSkill('claude', SKILL), `${SOURCE.trim()}\n`);

  for (const id of SKILL_TARGET_IDS.filter((target) => target !== 'claude')) {
    const rendered = renderSkill(id, SKILL);
    assert.ok(rendered.startsWith('---\nname: codebrain\ndescription: Use CodeBrain'), id);
    // Keys a strict loader does not know would get the skill skipped.
    assert.ok(!rendered.includes('user-invocable'), id);
    assert.ok(!rendered.includes('argument-hint'), id);
    assert.ok(rendered.includes('`codegraph_explore`'), id);
  }
});

test('a description YAML would misread is quoted', () => {
  const awkward = parseSkill('---\nname: x\ndescription: Use it: when "tracing"\n---\n\n# X\n\nbody', 'x');
  const rendered = renderSkill('codex', awkward);
  assert.ok(rendered.includes('description: "Use it: when \\"tracing\\""'));
});

test('an install replaces the copy an earlier release wrote at the same scope', () => {
  const paths = sandbox();
  const prompt = join(paths.homeDir, '.codex', 'prompts', 'codebrain.md');
  const command = join(paths.workspaceRoot, '.gemini', 'commands', 'codebrain.toml');
  const geminiMd = join(paths.homeDir, '.gemini', 'GEMINI.md');
  const copilotMd = join(paths.workspaceRoot, '.github', 'copilot-instructions.md');
  mkdirSync(join(paths.homeDir, '.codex', 'prompts'), { recursive: true });
  mkdirSync(join(paths.workspaceRoot, '.gemini', 'commands'), { recursive: true });
  mkdirSync(join(paths.workspaceRoot, '.github'), { recursive: true });
  mkdirSync(join(paths.homeDir, '.gemini'), { recursive: true });
  writeFileSync(prompt, 'old prompt\n');
  writeFileSync(command, 'prompt = "old"\n');
  const block = `${SKILL_BLOCK_START}\n## CodeBrain\n\nold\n${SKILL_BLOCK_END}\n`;
  writeFileSync(geminiMd, `# My instructions\n\n${block}`);
  writeFileSync(copilotMd, `Team rules.\n\n${block}`);

  const codex = installSkill(SKILL, 'codex', paths, 'global');
  assert.deepEqual(codex.migrated, [prompt]);
  assert.equal(existsSync(prompt), false);

  // A global Gemini install leaves the project's legacy command alone.
  assert.equal(installSkill(SKILL, 'gemini', paths, 'global').migrated, undefined);
  assert.equal(existsSync(command), true);
  assert.deepEqual(installSkill(SKILL, 'gemini', paths, 'project').migrated, [command]);
  assert.equal(existsSync(command), false);

  // Marked blocks come out; the user's own text stays.
  installSkill(SKILL, 'antigravity', paths, 'global');
  assert.equal(read(geminiMd), '# My instructions\n');
  installSkill(SKILL, 'copilot', paths, 'project');
  assert.equal(read(copilotMd), 'Team rules.\n');
});

test('uninstall sweeps legacy copies too', () => {
  const paths = sandbox();
  const prompt = join(paths.homeDir, '.codex', 'prompts', 'codebrain.md');
  mkdirSync(join(paths.homeDir, '.codex', 'prompts'), { recursive: true });
  writeFileSync(prompt, 'old prompt\n');

  const removed = removeSkill(SKILL, 'codex', paths);
  assert.equal(removed.action, 'removed');
  assert.deepEqual(removed.paths, [prompt]);
  assert.equal(existsSync(prompt), false);
});

test('project scope with no folder open has nowhere to write', () => {
  const homeOnly = { homeDir: sandbox().homeDir };
  const result = installSkill(SKILL, 'claude', homeOnly, 'project');
  assert.equal(result.action, 'skipped');
  assert.match(result.reason, /no folder is open/);
  assert.deepEqual(skillArtifacts('claude', SKILL, homeOnly, 'project'), []);
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

test('a legacy copy is always stale, so a refresh migrates it', () => {
  const paths = sandbox();
  mkdirSync(join(paths.homeDir, '.gemini', 'commands'), { recursive: true });
  writeFileSync(join(paths.homeDir, '.gemini', 'commands', 'codebrain.toml'), 'prompt = "old"\n');

  const installed = readInstalledSkills(SKILL, 'gemini', paths);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].artifact.kind, 'legacy-file');
  assert.equal(isSkillStale(installed[0], SKILL, 'gemini'), true);
});
