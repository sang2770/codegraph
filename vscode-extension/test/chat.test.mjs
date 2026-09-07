import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTypeScript } from './helpers/load.mjs';

/**
 * Minimum of the chat API `chat.ts` touches.
 *
 * The turn and message classes are real classes because the module under test
 * discriminates history with `instanceof`.
 */
class ChatRequestTurn {
  constructor(prompt, command) {
    this.prompt = prompt;
    this.command = command;
  }
}

class ChatResponseMarkdownPart {
  constructor(value) {
    this.value = { value };
  }
}

class ChatResponseTurn {
  constructor(response) {
    this.response = response;
  }
}

const vscode = {
  ChatRequestTurn,
  ChatResponseTurn,
  ChatResponseMarkdownPart,
  LanguageModelChatMessage: {
    User: (content) => ({ role: 'user', content }),
    Assistant: (content) => ({ role: 'assistant', content }),
  },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  LanguageModelTextPart: class {
    constructor(value) {
      this.value = value;
    }
  },
  LanguageModelToolCallPart: class {},
  LanguageModelToolResultPart: class {},
  Uri: {
    file: (path) => ({ fsPath: path, scheme: 'file' }),
    joinPath: (base, ...parts) => ({ fsPath: join(base.fsPath, ...parts) }),
  },
  Location: class {
    constructor(uri, position) {
      this.uri = uri;
      this.position = position;
    }
  },
  Position: class {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
    dispose() {}
  },
  FileType: { File: 1, Directory: 2 },
  env: { language: 'en' },
  window: {
    activeTextEditor: undefined,
    createStatusBarItem: () => ({ show() {}, dispose() {}, tooltip: '', text: '' }),
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    showQuickPick: async () => undefined,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (_key, fallback) => fallback, inspect: () => undefined }),
    getWorkspaceFolder: () => undefined,
    createFileSystemWatcher: () => ({
      onDidCreate: () => ({ dispose() {} }),
      onDidChange: () => ({ dispose() {} }),
      onDidDelete: () => ({ dispose() {} }),
      dispose() {},
    }),
    fs: {},
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Window: 10, Notification: 15 },
  ThemeIcon: class {},
  RelativePattern: class {},
  chat: { createChatParticipant: () => ({}) },
  lm: { tools: [] },
};

const {
  inferCommand,
  matchesTrigger,
  mentionsCommitHistory,
  historyMessages,
  tokenUsageFooter,
  extractCodeReferences,
  buildFileTree,
  scaleContextFiles,
  collectPromptReferences,
} = loadTypeScript('chat.ts', { vscode });

test('routes Vietnamese impact and review prompts to the right command', () => {
  // Regression: these were wrapped in `\b`, which is ASCII-only, so a phrase
  // starting with `ả` or `đ` could never match and always fell through to
  // /explain — including the example shipped in the participant manifest.
  assert.equal(
    inferCommand({ command: undefined, prompt: 'Phân tích ảnh hưởng của thay đổi này' }),
    'impact',
  );
  assert.equal(
    inferCommand({ command: undefined, prompt: 'đánh giá code này giúp mình' }),
    'review',
  );
  assert.equal(
    inferCommand({ command: undefined, prompt: 'tác động của thay đổi này là gì' }),
    'impact',
  );
});

test('routes English prompts and honours an explicit command', () => {
  assert.equal(
    inferCommand({ command: undefined, prompt: 'Which tests are affected?' }),
    'impact',
  );
  assert.equal(
    inferCommand({ command: undefined, prompt: 'Review my diff' }),
    'review',
  );
  assert.equal(
    inferCommand({ command: undefined, prompt: 'What is the root cause?' }),
    'fix',
  );
  assert.equal(
    inferCommand({ command: undefined, prompt: 'Write a user guide for export' }),
    'guide',
  );
  assert.equal(
    inferCommand({ command: undefined, prompt: 'How does checkout work?' }),
    'explain',
  );
  // An explicit slash command always wins over prompt keywords.
  assert.equal(
    inferCommand({ command: 'explain', prompt: 'review this bug impact' }),
    'explain',
  );
});

test('trigger matching respects whole words in both scripts', () => {
  assert.equal(matchesTrigger('prefix suffix', ['fix']), false);
  assert.equal(matchesTrigger('please fix this', ['fix']), true);
  assert.equal(matchesTrigger('không ảnh hưởng gì', ['ảnh hưởng']), true);
  assert.equal(matchesTrigger('đánh giá', ['đánh giá']), true);
});

test('only opens the commit picker when the user asked about commits', () => {
  assert.equal(mentionsCommitHistory('review my changes'), false);
  assert.equal(mentionsCommitHistory('review the last commit'), true);
  assert.equal(mentionsCommitHistory('xem lịch sử thay đổi'), true);
});

test('carries earlier turns as real chat messages', () => {
  const messages = historyMessages([
    new ChatRequestTurn('explain the auth flow', 'explain'),
    new ChatResponseTurn([
      new ChatResponseMarkdownPart('# Workflow\n\n```mermaid\nflowchart LR\n  A-->B\n```\n\nAuth starts at login.'),
    ]),
    new ChatRequestTurn('what about the other one?', undefined),
  ]);

  assert.deepEqual(
    messages.map((message) => message.role),
    ['user', 'assistant', 'user'],
  );
  assert.equal(messages[0].content, '/explain explain the auth flow');
  // A diagram carries no continuity value and costs a lot of budget.
  assert.match(messages[1].content, /\[diagram\]/);
  assert.doesNotMatch(messages[1].content, /flowchart/);
});

test('truncates a long previous report instead of replaying it', () => {
  const [message] = historyMessages(
    [new ChatResponseTurn([new ChatResponseMarkdownPart('x'.repeat(5_000))])],
    4,
    100,
  );

  assert.ok(message.content.length < 200);
});

test('reports unknown savings when no baseline file could be measured', () => {
  const footer = tokenUsageFooter(
    {
      command: 'explain',
      model: 'test-model',
      generatedAt: '',
      codeBrainContextTokens: 0,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      latencyMs: 1_200,
      baselineTokens: 0,
      baselineFiles: 0,
      baselineMeasured: false,
    },
    'en',
    { contextCharacters: 400 },
  );

  assert.match(footer, /unknown/);
  assert.doesNotMatch(footer, /Difference/);
});

test('compares graph context against the measured full-read cost', () => {
  const footer = tokenUsageFooter(
    {
      command: 'explain',
      model: 'test-model',
      generatedAt: '',
      codeBrainContextTokens: 0,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      latencyMs: 1_200,
      baselineTokens: 10_000,
      baselineFiles: 4,
      baselineMeasured: true,
    },
    'en',
    // 4_000 characters at 4 bytes per token is 1_000 tokens against 10_000.
    { contextCharacters: 4_000 },
  );

  assert.match(footer, /1,000/);
  assert.match(footer, /10,000/);
  assert.match(footer, /~90%/);
});

test('pulls file and line citations out of a finished report', () => {
  const references = extractCodeReferences(`
See \`src/auth/login.ts:42\` and src/auth/login.ts:42 again.
Also (src/db/session.ts:7) and https://example.com/x.ts:9 which is not code.
`);

  assert.deepEqual(references, [
    { path: 'src/auth/login.ts', line: 42 },
    { path: 'src/db/session.ts', line: 7 },
  ]);
});

test('caps the number of citations offered as anchors', () => {
  const report = Array.from(
    { length: 30 },
    (_value, index) => `src/file${index}.ts:${index + 1}`,
  ).join('\n');

  assert.equal(extractCodeReferences(report, 5).length, 5);
});

test('nests changed paths into a file tree', () => {
  const tree = buildFileTree(['src/a/one.ts', 'src/a/two.ts', 'src/b.ts', 'README.md']);

  assert.deepEqual(tree, [
    {
      name: 'src',
      children: [
        { name: 'a', children: [{ name: 'one.ts' }, { name: 'two.ts' }] },
        { name: 'b.ts' },
      ],
    },
    { name: 'README.md' },
  ]);
});

test('scales the file budget with the size of the indexed project', () => {
  const tiers = [0, 100, 3_000, 10_000, 40_000].map(scaleContextFiles);

  // A larger project must never get a smaller budget than a smaller one.
  const sized = [100, 3_000, 10_000, 40_000].map(scaleContextFiles);
  for (let index = 1; index < sized.length; index += 1) {
    assert.ok(sized[index] >= sized[index - 1]);
  }
  // An unknown size falls back to the documented default rather than to zero.
  assert.equal(tiers[0], 12);
});

test('reads attachments the user pinned to the prompt', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codebrain-refs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'service.ts'), 'line one\nline two\nline three\n');

  const { evidence, hints } = collectPromptReferences(
    [
      { id: 'file', value: { fsPath: join(root, 'service.ts'), scheme: 'file' } },
      {
        id: 'selection',
        value: {
          uri: { fsPath: join(root, 'service.ts') },
          range: { start: { line: 1 }, end: { line: 1 } },
        },
      },
    ],
    root,
  );

  assert.match(evidence, /### service\.ts/);
  assert.match(evidence, /line one/);
  // A Location attachment contributes only its own lines, labelled with them.
  assert.match(evidence, /### service\.ts:2-2/);
  assert.match(evidence, /```ts/);
  assert.deepEqual(hints, ['service.ts', 'service']);
});

test('names but does not read an attachment from outside the project', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codebrain-refs-'));
  const outside = mkdtempSync(join(tmpdir(), 'codebrain-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(join(outside, 'secret.env'), 'TOKEN=abc123\n');

  const { evidence, hints } = collectPromptReferences(
    [{ id: 'file', value: { fsPath: join(outside, 'secret.env'), scheme: 'file' } }],
    root,
  );

  assert.match(evidence, /outside the project/);
  assert.doesNotMatch(evidence, /abc123/);
  assert.deepEqual(hints, []);
});

test('keeps plain-text and described attachments', () => {
  const { evidence } = collectPromptReferences(
    [
      { id: 'terminalSelection', value: 'TypeError: cannot read x of undefined' },
      { id: 'codebase', value: undefined, modelDescription: 'The whole workspace' },
    ],
    '/repo',
  );

  assert.match(evidence, /TypeError/);
  assert.match(evidence, /The whole workspace/);
});

test('returns nothing when the user attached nothing', () => {
  assert.deepEqual(collectPromptReferences([], '/repo'), { evidence: '', hints: [] });
});
