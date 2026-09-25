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
  scaleContextFiles,
  collectPromptReferences,
  extractHandoffPrompt,
  resolveIssueKey,
  ticketEvidence,
  buildFocusQuery,
  editorQueryHints,
  isContinuation,
  previousResult,
  wantsImpactAnalysis,
  withDeadline,
} = loadTypeScript('chat.ts', { vscode });

test('routes Vietnamese impact and review prompts to the right command', () => {
  // Regression: these were wrapped in `\b`, which is ASCII-only, so a phrase
  // starting with `ả` or `đ` could never match and always fell through to
  // /explain — including the example shipped in the participant manifest.
  assert.equal(
    inferCommand({ command: undefined, prompt: 'Phân tích ảnh hưởng của thay đổi này' }),
    'review',
  );
  assert.equal(
    inferCommand({ command: undefined, prompt: 'đánh giá code này giúp mình' }),
    'review',
  );
  assert.equal(
    inferCommand({ command: undefined, prompt: 'tác động của thay đổi này là gì' }),
    'review',
  );
  // Impact questions are reviews that also get the deterministic analysis.
  assert.ok(wantsImpactAnalysis('Phân tích ảnh hưởng của thay đổi này'));
  assert.ok(wantsImpactAnalysis('Which tests are affected?'));
  assert.ok(!wantsImpactAnalysis('Review my diff'));
});

test('routes English prompts and honours an explicit command', () => {
  assert.equal(
    inferCommand({ command: undefined, prompt: 'Which tests are affected?' }),
    'review',
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
  // /impact from an older thread or a saved prompt now runs a review.
  assert.equal(inferCommand({ command: 'impact', prompt: 'x' }), 'review');
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

test('routes implementation requests to /implement without stealing explain questions', () => {
  assert.equal(inferCommand({ command: undefined, prompt: 'Implement ABC-12 password reset' }), 'implement');
  assert.equal(inferCommand({ command: undefined, prompt: 'Triển khai chức năng xuất PDF' }), 'implement');
  assert.equal(inferCommand({ command: undefined, prompt: 'Thêm tính năng lọc đơn hàng' }), 'implement');
  // "implemented" describes existing code; that is a question, not a task.
  assert.equal(inferCommand({ command: undefined, prompt: 'How is caching implemented?' }), 'explain');
  // A bug report stays a bug report even when it says implement.
  assert.equal(inferCommand({ command: undefined, prompt: 'Fix the bug in the implement step' }), 'fix');
  assert.equal(inferCommand({ command: 'implement', prompt: 'review this' }), 'implement');
});

test('the Jira key comes from the prompt first, then the branch', () => {
  assert.equal(resolveIssueKey('Implement abc-12 now', 'feature/XYZ-9-thing'), 'ABC-12');
  assert.equal(resolveIssueKey('Implement the export', 'feature/xyz-9-export'), 'XYZ-9');
  assert.equal(resolveIssueKey('How does login work?', 'main'), undefined);
  assert.equal(resolveIssueKey('How does login work?', undefined), undefined);
});

test('ticket context becomes a labelled evidence section, or nothing', () => {
  assert.equal(ticketEvidence(undefined), '');
  assert.equal(ticketEvidence({ text: '  ' }), '');
  const section = ticketEvidence({ text: '# ABC-1 — Reset' });
  assert.match(section, /^## Jira ticket and specification/);
  assert.match(section, /# ABC-1 — Reset$/);
});

test('the handoff prompt is taken from its fenced block', () => {
  const report = [
    '# Implementation plan: reset',
    '## Change plan',
    'table',
    '## Handoff prompt',
    '```text',
    'Implement ABC-1.',
    'Add tests.',
    '```',
    '## Trailing',
  ].join('\n');
  assert.equal(extractHandoffPrompt(report), 'Implement ABC-1.\nAdd tests.');
  // An unfenced section still yields its text, up to the next heading.
  assert.equal(extractHandoffPrompt('## Handoff prompt\nDo the thing.\n## Next'), 'Do the thing.');
  assert.equal(extractHandoffPrompt('# Plan\n## Goal\nNo handoff here.'), undefined);
});

test('the explore query carries only what points at code', () => {
  const editor = 'Active file: src/cart/checkout.ts\nSelected lines: 10-12\nSelected code:\nconst total = cartTotals(items);\nPaymentGateway.charge(total);';
  assert.deepEqual(editorQueryHints(editor), ['src/cart/checkout.ts', 'PaymentGateway.charge', 'cartTotals', 'PaymentGateway']);
  assert.deepEqual(editorQueryHints(''), []);
  const query = buildFocusQuery(['Why is checkout slow?', 'src/cart/checkout.ts', 'src/cart/checkout.ts', '', undefined], 'entry');
  assert.equal(query, 'Why is checkout slow? src/cart/checkout.ts');
  // No report boilerplate leaks into what explore ranks on.
  assert.doesNotMatch(query, /business workflow|side effects|affected tests|Active file/);
  assert.equal(buildFocusQuery([' ', undefined], 'main entry point'), 'main entry point');
  assert.equal(buildFocusQuery(['x'.repeat(5_000)], 'f').length, 2_000);
});

test('ordinary questions are not mistaken for bugs, reviews or features', () => {
  const cases = {
    'What is the cause of the extra re-render?': 'explain',
    'Explain the solution architecture': 'explain',
    'What is the diff between the v1 and v2 API?': 'explain',
    'Is there any risk of a deadlock in the queue?': 'explain',
    'How do I build a plugin for this?': 'explain',
    'Login crashes after a token refresh': 'fix',
    'Tại sao đăng nhập bị lỗi?': 'fix',
    'Review my changes': 'review',
    'Check this diff for regression risk': 'review',
  };
  for (const [prompt, expected] of Object.entries(cases)) {
    assert.equal(inferCommand({ command: undefined, prompt }), expected, prompt);
  }
});

test('a follow-up without a keyword continues the thread\'s task', () => {
  assert.equal(inferCommand({ command: undefined, prompt: 'tiếp tục bước 2' }, 'implement'), 'implement');
  assert.equal(inferCommand({ command: undefined, prompt: 'and for the admin role?' }, 'review'), 'review');
  // A real question is an explanation whatever came before.
  assert.equal(inferCommand({ command: undefined, prompt: 'How does the queue drain?' }, 'review'), 'explain');
  // A keyword or an explicit command still wins over the thread.
  assert.equal(inferCommand({ command: undefined, prompt: 'now fix the crash' }, 'implement'), 'fix');
  assert.equal(inferCommand({ command: 'guide', prompt: 'ok' }, 'implement'), 'guide');
  assert.equal(inferCommand({ command: undefined, prompt: 'ok' }), 'explain');
});

test('go-ahead replies are recognised, questions are not', () => {
  for (const prompt of ['ok', 'OK làm đi', 'làm đi', 'tiếp tục bước 2', 'go ahead', 'lgtm, proceed']) {
    assert.ok(isContinuation(prompt), prompt);
  }
  for (const prompt of ['how does it work?', 'okra recipe', 'Review this', `ok ${'x'.repeat(200)}`]) {
    assert.ok(!isContinuation(prompt), prompt);
  }
});

test('the previous answer\'s command, plan and ticket are read back from history', () => {
  const answer = new ChatResponseTurn([]);
  answer.result = { metadata: { command: 'implement', handoff: 'Do X.', ticket: 'ABC-1' } };
  const older = new ChatResponseTurn([]);
  older.result = { metadata: { command: 'review' } };
  assert.deepEqual(previousResult([older, new ChatRequestTurn('p'), answer, new ChatRequestTurn('ok')]), {
    command: 'implement',
    handoff: 'Do X.',
    ticket: 'ABC-1',
  });
  const junk = new ChatResponseTurn([]);
  junk.result = { metadata: { command: 'deploy', handoff: 42 } };
  assert.deepEqual(previousResult([junk]), { command: undefined, handoff: undefined, ticket: undefined });
  assert.deepEqual(previousResult([]), {});
});

test('a slow or cancelled lookup stops holding up the report', async () => {
  assert.equal(await withDeadline(Promise.resolve(7), 1_000), 7);
  assert.equal(await withDeadline(new Promise(() => {}), 20), undefined);
  assert.equal(await withDeadline(Promise.reject(new Error('x')), 1_000), undefined);

  let cancel;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener) => {
      cancel = listener;
      return { dispose() {} };
    },
  };
  const pending = withDeadline(new Promise(() => {}), 60_000, token);
  cancel();
  assert.equal(await pending, undefined);
  assert.equal(await withDeadline(Promise.resolve(1), 1_000, { isCancellationRequested: true }), undefined);
});

