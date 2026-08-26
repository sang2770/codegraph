import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTypeScript } from './helpers/load.mjs';

const { SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_WRITE, handleMessage, splitFrames } =
  loadTypeScript('atlassian/server.ts');

function envFileWith(lines) {
  const file = join(mkdtempSync(join(tmpdir(), 'codebrain-server-')), 'atlassian.env');
  writeFileSync(file, lines.join('\n'));
  return { CODEBRAIN_ATLASSIAN_ENV: file };
}

const CONFIGURED = envFileWith([
  'JIRA_URL="https://jira.example.com"',
  'JIRA_PERSONAL_TOKEN="tok"',
]);

test('initialize echoes a supported protocol version and advertises tools', async () => {
  const response = await handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {} },
  });

  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, '2024-11-05');
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: true } });
  assert.equal(response.result.serverInfo.name, 'codebrain-atlassian');
  assert.equal(response.result.instructions, SERVER_INSTRUCTIONS);
});

test('an unknown protocol version falls back to the newest supported one', async () => {
  const response = await handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2019-01-01' },
  });
  assert.equal(response.result.protocolVersion, '2025-06-18');
});

test('the instructions name the flows the tools are for', () => {
  for (const fragment of [
    'jira_get_issue',
    'confluence_search',
    'confluence_get_page',
    'jira_get_issue_images',
    'already read',
  ]) {
    assert.ok(SERVER_INSTRUCTIONS.includes(fragment), `instructions should mention ${fragment}`);
  }
  // A read-only session must not be told about tools it does not have.
  for (const fragment of ['jira_add_comment', 'confluence_update_page', 'Write access']) {
    assert.ok(!SERVER_INSTRUCTIONS.includes(fragment), `read-only instructions must omit ${fragment}`);
  }
});

test('enabling writes changes both the instructions and the tool list', async () => {
  const env = { ...CONFIGURED, CODEBRAIN_ATLASSIAN_ALLOW_WRITE: '1' };
  const initialize = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { env, home: '/nonexistent' },
  );
  assert.equal(initialize.result.instructions, SERVER_INSTRUCTIONS + SERVER_INSTRUCTIONS_WRITE);
  assert.match(initialize.result.instructions, /Ask the user before the first write/);

  const list = await handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { env, home: '/nonexistent' },
  );
  const names = list.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('jira_add_comment'));
  assert.ok(names.includes('jira_transition_issue'));
});

test('only an explicit affirmative turns writing on', async () => {
  for (const value of ['0', 'false', 'no', '', 'maybe']) {
    const list = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { env: { ...CONFIGURED, CODEBRAIN_ATLASSIAN_ALLOW_WRITE: value }, home: '/nonexistent' },
    );
    const names = list.result.tools.map((tool) => tool.name);
    assert.ok(
      !names.includes('jira_add_comment'),
      `CODEBRAIN_ATLASSIAN_ALLOW_WRITE="${value}" must not enable writing`,
    );
  }
});

test('the env file can enable writing for agents that pass no environment', async () => {
  const env = envFileWith([
    'JIRA_URL="https://jira.example.com"',
    'JIRA_PERSONAL_TOKEN="tok"',
    'CODEBRAIN_ATLASSIAN_ALLOW_WRITE="1"',
  ]);
  const list = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { env, home: '/nonexistent' },
  );
  assert.ok(list.result.tools.map((tool) => tool.name).includes('jira_add_comment'));
});

test('notifications are never answered', async () => {
  for (const method of ['notifications/initialized', 'notifications/cancelled', 'ping']) {
    assert.equal(await handleMessage({ jsonrpc: '2.0', method }), null);
  }
});

test('ping with an id is answered with an empty result', async () => {
  const response = await handleMessage({ jsonrpc: '2.0', id: 7, method: 'ping' });
  assert.deepEqual(response, { jsonrpc: '2.0', id: 7, result: {} });
});

test('an unknown method returns method-not-found', async () => {
  const response = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /resources\/list/);
});

test('tools/list reflects the products the env file configures', async () => {
  const response = await handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    { env: CONFIGURED, home: '/nonexistent' },
  );
  assert.deepEqual(
    response.result.tools.map((tool) => tool.name),
    ['jira_search', 'jira_get_issue', 'jira_get_comments', 'jira_get_issue_images'],
  );
});

test('a tool call with nothing configured returns guidance, not an error', async () => {
  const empty = envFileWith(['# nothing here']);
  const response = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'jira_search', arguments: { query: 'x' } },
    },
    { env: empty, home: '/nonexistent' },
  );
  assert.equal(response.result.isError, undefined);
  assert.match(response.result.content[0].text, /Jira is not configured/);
});

test('a tool call reaches the injected transport with the resolved token', async () => {
  const requests = [];
  const response = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'jira_search', arguments: { query: 'rollback' } },
    },
    {
      env: CONFIGURED,
      home: '/nonexistent',
      fetchImpl: async (url, init) => {
        requests.push({ url, authorization: init.headers.Authorization });
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ total: 0, issues: [] }) };
      },
    },
  );

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/jira\.example\.com\/rest\/api\/2\/search\?/);
  assert.equal(requests[0].authorization, 'Bearer tok');
  assert.match(response.result.content[0].text, /No Jira issues for JQL/);
});

test('env vars override the file for a single session', async () => {
  const requests = [];
  await handleMessage(
    {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'jira_search', arguments: { query: 'x' } },
    },
    {
      env: { ...CONFIGURED, JIRA_URL: 'https://other.example.com', JIRA_PERSONAL_TOKEN: 'override' },
      home: '/nonexistent',
      fetchImpl: async (url, init) => {
        requests.push({ url, authorization: init.headers.Authorization });
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ issues: [] }) };
      },
    },
  );
  assert.match(requests[0].url, /^https:\/\/other\.example\.com\//);
  assert.equal(requests[0].authorization, 'Bearer override');
});

test('a tool call limit can be tuned without touching the request', async () => {
  const requests = [];
  await handleMessage(
    {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'jira_search', arguments: { query: 'x' } },
    },
    {
      env: { ...CONFIGURED, CODEBRAIN_ATLASSIAN_MAX_RESULTS: '3' },
      home: '/nonexistent',
      fetchImpl: async (url) => {
        requests.push(new URL(url).searchParams.get('maxResults'));
        return { ok: true, status: 200, statusText: 'OK', json: async () => ({ issues: [] }) };
      },
    },
  );
  assert.equal(requests[0], '3');
});

test('a tool set change fires the list-changed callback once it is known', async () => {
  let changes = 0;
  const onToolsChanged = () => {
    changes += 1;
  };
  const options = { home: '/nonexistent', onToolsChanged };

  await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { ...options, env: CONFIGURED });
  const before = changes;
  await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { ...options, env: CONFIGURED });
  assert.equal(changes, before, 'an unchanged tool set must not notify');

  await handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    {
      ...options,
      env: envFileWith([
        'JIRA_URL="https://jira.example.com"',
        'JIRA_PERSONAL_TOKEN="tok"',
        'CONFLUENCE_URL="https://collab.example.com"',
        'CONFLUENCE_PERSONAL_TOKEN="tok"',
      ]),
    },
  );
  assert.equal(changes, before + 1);
});

test('frames are split on newlines and a partial line is held back', () => {
  assert.deepEqual(splitFrames('{"a":1}\n{"b":2}\n{"c":'), {
    frames: ['{"a":1}', '{"b":2}'],
    rest: '{"c":',
  });
  // Blank lines and stray whitespace are not messages.
  assert.deepEqual(splitFrames('\n  \n{"a":1}\n'), { frames: ['{"a":1}'], rest: '' });
  assert.deepEqual(splitFrames(''), { frames: [], rest: '' });
});
