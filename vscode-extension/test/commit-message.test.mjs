import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const { cleanCommitMessage, commitPrompt } = loadTypeScript('commitMessage.ts', {
  // The module reaches for the workspace and the model only inside the
  // commands; the pure prompt helpers under test need neither.
  vscode: {
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: {},
    extensions: {},
    Uri: {},
    ProgressLocation: {},
    ConfigurationTarget: {},
    LanguageModelChatMessage: {},
  },
});
const {
  COMMIT_FORMATS,
  COMMIT_FORMAT_IDS,
  DEFAULT_COMMIT_FORMAT,
  commitInstructions,
  isCommitFormat,
} = loadTypeScript('commitFormats.ts');

const CHANGES = {
  diff: 'diff --git a/src/a.ts b/src/a.ts\n+const answer = 42;\n',
  stat: ' src/a.ts | 1 +',
  files: ['src/a.ts', 'src/b.ts'],
  staged: true,
  truncated: false,
  branch: 'feature/TPLD-958-chart-lag',
  recentSubjects: ['TPLD-957: Fix legend overlap', 'TPLD-940: Add zoom control'],
};

// -------------------------------------------------------------------- prompt

test('the prompt carries the template, the file list, the stat and the diff', () => {
  const prompt = commitPrompt('Write it in Vietnamese.', CHANGES);

  assert.ok(prompt.includes('Write it in Vietnamese.'));
  assert.ok(prompt.includes('- src/a.ts'));
  assert.ok(prompt.includes('- src/b.ts'));
  assert.ok(prompt.includes(' src/a.ts | 1 +'));
  assert.ok(prompt.includes('const answer = 42;'));
  // The model has to know whether it is describing the commit that is about to
  // happen or the whole working tree.
  assert.ok(prompt.includes('(staged)'));
  assert.ok(!prompt.includes('truncated'));
});

test('the branch and recent subjects reach the model', () => {
  // A convention that takes the issue key from the branch is impossible to
  // follow from the diff alone, so the branch has to be in the prompt.
  const prompt = commitPrompt('T', CHANGES);
  assert.ok(prompt.includes('Current branch: feature/TPLD-958-chart-lag'));
  assert.ok(prompt.includes('- TPLD-957: Fix legend overlap'));
  // History is context, not an instruction — the template has to outrank it.
  assert.match(prompt, /instructions above win/i);
});

test('a detached HEAD and an empty history degrade quietly', () => {
  const prompt = commitPrompt('T', { ...CHANGES, branch: undefined, recentSubjects: [] });
  assert.ok(prompt.includes('detached HEAD'));
  assert.ok(!prompt.includes('Recent commit subjects'));
});

test('an unstaged run says so, and a truncated diff warns against guessing', () => {
  const prompt = commitPrompt('T', { ...CHANGES, staged: false, truncated: true });
  assert.ok(prompt.includes('not staged yet'));
  assert.match(prompt, /truncated/);
  assert.match(prompt, /do not guess/i);
});

test('empty sections are left out instead of appearing as blank headings', () => {
  const prompt = commitPrompt('T', { ...CHANGES, stat: '', files: [] });
  assert.ok(!prompt.includes('Files:'));
  assert.ok(!prompt.includes('Summary:'));
  assert.ok(prompt.includes('Diff:'));
});

// --------------------------------------------------------------- formats

test('every format is pickable, self-describing and carries the shared rules', () => {
  assert.ok(COMMIT_FORMAT_IDS.length >= 2);
  assert.ok(isCommitFormat(DEFAULT_COMMIT_FORMAT));
  assert.equal(isCommitFormat('nope'), false);
  assert.equal(isCommitFormat(undefined), false);

  for (const id of COMMIT_FORMAT_IDS) {
    const format = COMMIT_FORMATS[id];
    // The picker shows the example as the label, so an empty one is a blank row.
    assert.ok(format.example.trim().length > 0, `${id} has an example`);
    assert.ok(format.label.trim().length > 0, `${id} has a label`);
    assert.ok(format.description.trim().length > 0, `${id} has a description`);

    const instructions = commitInstructions(id);
    assert.ok(instructions.includes(format.instructions), `${id} keeps its own rules`);
    // A format that lets the model add commentary pastes that commentary
    // straight into the commit, so this rule has to reach every one of them.
    assert.match(instructions, /commit message only/i, `${id} forbids commentary`);
    assert.match(instructions, /Never invent an issue number/i, `${id} forbids invention`);
  }
});

test('the issue-key format states the branch rule and the three bullet levels', () => {
  const instructions = commitInstructions('issue-summary');
  assert.match(instructions, /from the branch name/i);
  // Without this the model invents a key whenever the branch has none.
  assert.match(instructions, /never invent a key/i);
  assert.ok(instructions.includes('Level 1 uses `-`'));
  assert.ok(instructions.includes('Level 2 uses `+`'));
  assert.ok(instructions.includes('Level 3 uses `*`'));
});

test('a configured language becomes a rule, and an empty one adds nothing', () => {
  const vietnamese = commitInstructions(DEFAULT_COMMIT_FORMAT, 'Vietnamese');
  assert.match(vietnamese, /Write the whole message in Vietnamese/);
  // Identifiers must not be translated along with the prose.
  assert.match(vietnamese, /Keep identifiers, file paths and issue keys/);

  for (const empty of ['', '   ', undefined]) {
    assert.ok(!commitInstructions(DEFAULT_COMMIT_FORMAT, empty).includes('## Language'));
  }
});

// --------------------------------------------------------------- extraction

test('a fenced answer is unwrapped', () => {
  assert.equal(
    cleanCommitMessage('```\nfeat(auth): add refresh tokens\n```'),
    'feat(auth): add refresh tokens',
  );
  assert.equal(
    cleanCommitMessage('```text\nfix(api): reject empty ids\n\nThe body.\n```'),
    'fix(api): reject empty ids\n\nThe body.',
  );
});

test('a conversational lead-in is dropped', () => {
  assert.equal(
    cleanCommitMessage("Here's the commit message:\n\nchore: bump deps"),
    'chore: bump deps',
  );
  assert.equal(cleanCommitMessage('Commit message:\nfix: typo'), 'fix: typo');
});

test('a fully quoted message loses its wrapping quotes', () => {
  assert.equal(cleanCommitMessage('"docs: fix the readme"'), 'docs: fix the readme');
  // A message with quotes of its own is left exactly as written.
  assert.equal(
    cleanCommitMessage('fix: handle the "empty" case'),
    'fix: handle the "empty" case',
  );
});

test('an ordinary message passes through untouched', () => {
  const message = 'feat(scm): generate commit messages\n\nWhy: typing them by hand.';
  assert.equal(cleanCommitMessage(message), message);
  assert.equal(cleanCommitMessage('   \n'), '');
});

test('a diff inside the message survives the fence stripping', () => {
  // Only a fence wrapping the WHOLE answer is a wrapper; one in the body is
  // content, and eating it would corrupt the message.
  const message = 'fix: correct the patch\n\n```diff\n-a\n+b\n```\n\nRefs #12';
  assert.equal(cleanCommitMessage(message), message);
});
