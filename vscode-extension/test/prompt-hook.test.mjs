import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTypeScript } from './helpers/load.mjs';

const { fileDedupeStore, promptHookOutput, ticketForPrompt } = loadTypeScript('atlassian/promptHook.ts');
const { extractPromptIssueKey } = loadTypeScript('jira/issueKey.ts');

function envWithJira() {
  const file = join(mkdtempSync(join(tmpdir(), 'codebrain-hook-')), 'atlassian.env');
  writeFileSync(file, 'JIRA_URL="https://jira.example.com"\nJIRA_PERSONAL_TOKEN="tok"\n');
  return { CODEBRAIN_ATLASSIAN_ENV: file };
}

function fetchWith(routes) {
  const calls = [];
  const impl = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const route = routes[path];
    if (route === undefined) {
      return { ok: false, status: 404, statusText: 'Not Found', text: async () => '{}' };
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => route };
  };
  impl.calls = calls;
  return impl;
}

const ISSUE = {
  '/rest/api/2/issue/ABC-7': {
    key: 'ABC-7',
    fields: { summary: 'Rate limit login', description: 'Acceptance criteria:\n- 5 attempts per minute\n- 429 after that' },
  },
  '/rest/api/2/issue/ABC-7/comment': { total: 0, comments: [] },
};

function memoryDedupe() {
  const seen = new Map();
  return {
    seen: (session, key) => seen.has(`${session}:${key}`),
    remember: (session, key) => seen.set(`${session}:${key}`, true),
  };
}

test('prose that only looks like a key is not a ticket', () => {
  assert.equal(extractPromptIssueKey('decode as utf-8 and hash with sha-256'), undefined);
  assert.equal(extractPromptIssueKey('see abc-12 and UTF-8'), 'ABC-12');
});

test('a key in the prompt counts; a branch key only for work on the ticket', () => {
  assert.equal(ticketForPrompt('what does ABC-3 change?', 'feature/XYZ-1-a'), 'ABC-3');
  assert.equal(ticketForPrompt('implement the remaining criteria', 'feature/xyz-1-a'), 'XYZ-1');
  assert.equal(ticketForPrompt('làm tiếp ticket này', 'feature/xyz-1-a'), 'XYZ-1');
  assert.equal(ticketForPrompt('what does parseConfig return?', 'feature/xyz-1-a'), undefined);
  assert.equal(ticketForPrompt('implement it', 'main'), undefined);
});

test('the hook injects the ticket with its criteria, once per session', async () => {
  const dedupe = memoryDedupe();
  const fetchImpl = fetchWith(ISSUE);
  const options = { env: envWithJira(), fetchImpl, branch: () => 'main', dedupe, home: '/nonexistent' };

  const out = await promptHookOutput({ prompt: 'Implement ABC-7', session_id: 's1' }, options);
  assert.match(out, /^<codebrain_ticket_context key="ABC-7"/);
  assert.match(out, /1\. 5 attempts per minute\n2\. 429 after that/);
  assert.match(out, /<\/codebrain_ticket_context>\n$/);

  assert.equal(await promptHookOutput({ prompt: 'continue ABC-7', session_id: 's1' }, options), '');
  assert.notEqual(await promptHookOutput({ prompt: 'Implement ABC-7', session_id: 's2' }, options), '');
});

test('the hook stays silent whenever it cannot help', async () => {
  const base = { branch: () => 'main', dedupe: memoryDedupe(), home: '/nonexistent' };
  // No key.
  assert.equal(await promptHookOutput({ prompt: 'how does login work?' }, { ...base, env: envWithJira(), fetchImpl: fetchWith(ISSUE) }), '');
  // Kill switch.
  assert.equal(
    await promptHookOutput({ prompt: 'ABC-7' }, { ...base, env: { ...envWithJira(), CODEBRAIN_NO_PROMPT_HOOK: '1' }, fetchImpl: fetchWith(ISSUE) }),
    '',
  );
  // Nothing configured: no request is even attempted.
  const unused = fetchWith(ISSUE);
  assert.equal(
    await promptHookOutput({ prompt: 'ABC-7' }, { ...base, env: { CODEBRAIN_ATLASSIAN_ENV: '/nonexistent/env' }, fetchImpl: unused }),
    '',
  );
  assert.deepEqual(unused.calls, []);
  // A key Jira does not know (404) is dropped rather than injected as an error.
  assert.equal(await promptHookOutput({ prompt: 'ABC-999' }, { ...base, env: envWithJira(), fetchImpl: fetchWith({}) }), '');
  // A thrown transport error is swallowed.
  assert.equal(
    await promptHookOutput({ prompt: 'ABC-7' }, { ...base, env: envWithJira(), fetchImpl: async () => { throw new Error('offline'); } }),
    '',
  );
});

test('the file dedupe store remembers per session and expires', () => {
  const store = fileDedupeStore(mkdtempSync(join(tmpdir(), 'codebrain-dedupe-')));
  assert.equal(store.seen('s', 'ABC-1', 1_000), false);
  store.remember('s', 'ABC-1', 1_000);
  assert.equal(store.seen('s', 'ABC-1', 2_000), true);
  assert.equal(store.seen('other', 'ABC-1', 2_000), false);
  assert.equal(store.seen('s', 'ABC-1', 1_000 + 31 * 60 * 1000), false);
  // Without a session id nothing is deduplicated.
  store.remember(undefined, 'ABC-2', 1_000);
  assert.equal(store.seen(undefined, 'ABC-2', 1_000), false);
});
