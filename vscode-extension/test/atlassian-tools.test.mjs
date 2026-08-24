import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const { AtlassianClient, authorizationHeader, isCloudUrl } =
  loadTypeScript('atlassian/client.ts');
const { adfToText, quoteQueryLiteral, storageToText, truncate } =
  loadTypeScript('atlassian/format.ts');
const { buildConfluenceCql, buildJiraJql, callTool, listTools, toolNames } =
  loadTypeScript('atlassian/tools.ts');

const CONNECTIONS = {
  jira: { baseUrl: 'https://jira.example.com', token: 'jira-token' },
  confluence: { baseUrl: 'https://collab.example.com', token: 'conf-token' },
};

/**
 * A fetch stand-in that records requests and replays canned payloads keyed by
 * path. Anything unmatched answers 404, which is what the real server does and
 * what the "recoverable failure" path needs to be exercised.
 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams) });
    const route = routes[parsed.pathname];
    if (!route) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => '{"errorMessages":["not found"]}',
      };
    }
    if (route instanceof Error) throw route;
    return { ok: true, status: 200, statusText: 'OK', json: async () => route };
  };
  impl.calls = calls;
  return impl;
}

function contextFor(routes, connections = CONNECTIONS) {
  const fetchImpl = fakeFetch(routes);
  return {
    context: {
      client: new AtlassianClient({ connections, fetchImpl }),
      connections,
      envFile: '/home/x/.codebrain/atlassian.env',
    },
    fetchImpl,
  };
}

const text = (result) => result.content[0].text;

// -------------------------------------------------------------- tool listing

test('only configured products are advertised', () => {
  assert.deepEqual(toolNames({ jira: CONNECTIONS.jira }), [
    'jira_search',
    'jira_get_issue',
    'jira_get_comments',
  ]);
  assert.deepEqual(toolNames({ confluence: CONNECTIONS.confluence }), [
    'confluence_search',
    'confluence_get_page',
  ]);
  assert.equal(toolNames(CONNECTIONS).length, 5);
  // Nothing configured still lists everything, so the reply can explain how to
  // configure it instead of the server looking broken.
  assert.equal(toolNames({}).length, 5);
});

test('every tool declares an object schema and no internal fields leak', () => {
  for (const tool of listTools(CONNECTIONS)) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 40, `${tool.name} needs a real description`);
    assert.equal(tool.product, undefined);
  }
});

// ------------------------------------------------------------ query building

test('free text is escaped into the generated JQL and CQL', () => {
  assert.equal(
    buildJiraJql({ query: 'say "hi"\\now', projectKey: 'ABC' }),
    'project = "ABC" AND text ~ "say \\"hi\\"\\\\now" ORDER BY updated DESC',
  );
  assert.equal(
    buildConfluenceCql({ query: 'rollback', spaceKey: 'PLATFORM' }),
    'text ~ "rollback" AND space = "PLATFORM" AND type in (page, blogpost) ORDER BY lastmodified DESC',
  );
  assert.equal(quoteQueryLiteral('a"b\\c'), '"a\\"b\\\\c"');
});

test('an explicit jql or cql is passed through verbatim', () => {
  assert.equal(buildJiraJql({ jql: 'project = ABC ORDER BY created ASC' }), 'project = ABC ORDER BY created ASC');
  assert.equal(buildConfluenceCql({ cql: 'label = "spec"' }), 'label = "spec"');
  // A supplied jql wins over free text rather than being combined with it.
  assert.equal(buildJiraJql({ jql: 'key = ABC-1', query: 'ignored' }), 'key = ABC-1');
});

// ------------------------------------------------------------------- guidance

test('an unconfigured product answers with guidance, never with isError', async () => {
  const { context } = contextFor({}, { confluence: CONNECTIONS.confluence });
  const result = await callTool('jira_search', { query: 'x' }, context);
  assert.equal(result.isError, undefined);
  assert.match(text(result), /Jira is not configured/);
  assert.match(text(result), /\.codebrain\/atlassian\.env/);
  assert.match(text(result), /do not retry this one in this session/);
});

test('a bad issue key is guidance that names the expected shape', async () => {
  const { context, fetchImpl } = contextFor({});
  const result = await callTool('jira_get_issue', { key: 'nope' }, context);
  assert.equal(result.isError, undefined);
  assert.match(text(result), /not a Jira issue key/);
  // No request is made for an argument we already know is wrong.
  assert.equal(fetchImpl.calls.length, 0);
});

test('a missing required argument names the alternatives', async () => {
  const { context } = contextFor({});
  assert.match(text(await callTool('jira_search', {}, context)), /needs jql .* or query/);
  assert.match(
    text(await callTool('confluence_get_page', {}, context)),
    /needs either pageId, or title/,
  );
});

test('a non-numeric pageId is rejected before the request', async () => {
  const { context, fetchImpl } = contextFor({});
  const result = await callTool('confluence_get_page', { pageId: 'OTA+Rollback' }, context);
  assert.match(text(result), /must be the numeric Confluence content id/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a wrong-typed argument is reported, not coerced', async () => {
  const { context } = contextFor({});
  assert.match(text(await callTool('jira_search', { query: 42 }, context)), /must be a string/);
});

test('an unknown tool lists the ones that exist', async () => {
  const { context } = contextFor({});
  const result = await callTool('jira_create_issue', {}, context);
  assert.equal(result.isError, undefined);
  assert.match(text(result), /Unknown tool "jira_create_issue"/);
  assert.match(text(result), /jira_search/);
});

test('an HTTP failure is recoverable guidance with a hint attached', async () => {
  const { context } = contextFor({});
  const result = await callTool('jira_get_issue', { key: 'ABC-1' }, context);
  assert.equal(result.isError, undefined);
  assert.match(text(result), /404 Not Found/);
  assert.match(text(result), /no such issue, page, or endpoint/);
});

test('a network failure explains what to check', async () => {
  const connections = CONNECTIONS;
  const context = {
    client: new AtlassianClient({
      connections,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    }),
    connections,
    envFile: '/tmp/atlassian.env',
  };
  const result = await callTool('jira_search', { query: 'x' }, context);
  assert.match(text(result), /Could not reach jira\.example\.com/);
  assert.match(text(result), /VPN\/proxy/);
});

test('an empty result set suggests the next move instead of looking broken', async () => {
  const { context } = contextFor({ '/rest/api/2/search': { total: 0, issues: [] } });
  const result = await callTool('jira_search', { query: 'nothing' }, context);
  assert.equal(result.isError, undefined);
  assert.match(text(result), /No Jira issues for JQL/);
  assert.match(text(result), /Next steps/);
});

// -------------------------------------------------------------------- results

test('jira_search returns the fields needed to choose what to open', async () => {
  const { context, fetchImpl } = contextFor({
    '/rest/api/2/search': {
      total: 42,
      issues: [
        {
          key: 'ABC-1234',
          fields: {
            summary: 'Rollback fails',
            status: { name: 'In Progress' },
            issuetype: { name: 'Bug' },
            priority: { name: 'High' },
            assignee: { displayName: 'Sang' },
            updated: '2026-08-20T04:15:00.000+0000',
          },
        },
      ],
    },
  });

  const body = text(await callTool('jira_search', { query: 'rollback', limit: 999 }, context));
  assert.match(body, /1 shown of 42/);
  assert.match(body, /## ABC-1234 — Rollback fails/);
  assert.match(body, /In Progress · Bug · High · assignee Sang · updated 2026-08-20 04:15/);
  assert.match(body, /URL: https:\/\/jira\.example\.com\/browse\/ABC-1234/);
  // An over-large limit is clamped rather than rejected.
  assert.equal(fetchImpl.calls[0].query.maxResults, '50');
});

test('jira_get_issue returns description and comments in one call', async () => {
  const { context } = contextFor({
    '/rest/api/2/issue/ABC-1234': {
      key: 'ABC-1234',
      fields: {
        summary: 'Rollback fails',
        status: { name: 'Open' },
        labels: ['ota'],
        components: [{ name: 'updater' }],
        description: 'Fill storage, then trigger OTA.',
        subtasks: [{ key: 'ABC-1235', fields: { summary: 'Guard', status: { name: 'Done' } } }],
        issuelinks: [
          { type: { outward: 'blocks' }, outwardIssue: { key: 'ABC-9', fields: { summary: 'Release' } } },
        ],
      },
    },
    '/rest/api/2/issue/ABC-1234/comment': {
      total: 1,
      comments: [
        {
          author: { displayName: 'QA' },
          created: '2026-08-22T09:00:00.000+0000',
          body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Repro confirmed.' }] }] },
        },
      ],
    },
  });

  // A lowercase key is normalised rather than rejected.
  const body = text(await callTool('jira_get_issue', { key: 'abc-1234' }, context));
  assert.match(body, /Labels: ota/);
  assert.match(body, /Components: updater/);
  assert.match(body, /## Subtasks\n- ABC-1235 — Guard \[Done\]/);
  assert.match(body, /- blocks: ABC-9 — Release/);
  assert.match(body, /Fill storage, then trigger OTA\./);
  assert.match(body, /### QA · 2026-08-22 09:00\nRepro confirmed\./);
});

test('the issue body survives a comment permission failure', async () => {
  const { context } = contextFor({
    '/rest/api/2/issue/ABC-1': { key: 'ABC-1', fields: { summary: 'S', description: 'D' } },
  });
  const body = text(await callTool('jira_get_issue', { key: 'ABC-1' }, context));
  assert.match(body, /## Description\n\nD/);
  assert.match(body, /Could not load comments/);
});

test('opting out of comments skips the extra request', async () => {
  const { context, fetchImpl } = contextFor({
    '/rest/api/2/issue/ABC-1': { key: 'ABC-1', fields: { summary: 'S' } },
  });
  await callTool('jira_get_issue', { key: 'ABC-1', includeComments: false }, context);
  assert.deepEqual(
    fetchImpl.calls.map((call) => call.path),
    ['/rest/api/2/issue/ABC-1'],
  );
});

test('confluence_search hands back the pageId the detail tool needs', async () => {
  const { context } = contextFor({
    '/rest/api/content/search': {
      totalSize: 3,
      results: [
        {
          id: '556677',
          type: 'page',
          title: 'OTA Rollback',
          space: { key: 'PLATFORM', name: 'Platform' },
          version: { number: 7, when: '2026-07-02T11:00:00.000Z', by: { displayName: 'Docs' } },
          excerpt: 'the <b>rollback</b> partition',
          _links: { webui: '/display/PLATFORM/OTA' },
        },
      ],
    },
  });

  const body = text(await callTool('confluence_search', { query: 'rollback' }, context));
  assert.match(body, /pageId: 556677/);
  assert.match(body, /space Platform \(PLATFORM\) · page · v7 · updated 2026-07-02 11:00 by Docs/);
  assert.match(body, /URL: https:\/\/collab\.example\.com\/display\/PLATFORM\/OTA/);
  assert.match(body, /the rollback partition/);
});

test('an ambiguous title asks for a space instead of guessing', async () => {
  const { context } = contextFor({
    '/rest/api/content': {
      results: [
        { id: '1', title: 'Design', space: { key: 'A' } },
        { id: '2', title: 'Design', space: { key: 'B' } },
      ],
    },
  });
  const body = text(await callTool('confluence_get_page', { title: 'Design' }, context));
  assert.match(body, /matches 2 pages/);
  assert.match(body, /pageId: 1/);
  assert.match(body, /pageId: 2/);
});

test('a page with no body says so rather than returning nothing', async () => {
  const { context } = contextFor({
    '/rest/api/content/1': { id: '1', title: 'Container', body: { storage: { value: '' } } },
  });
  const body = text(await callTool('confluence_get_page', { pageId: '1' }, context));
  assert.match(body, /has no text body/);
});

test('a long page body is truncated with a visible note', async () => {
  const { context } = contextFor({
    '/rest/api/content/1': {
      id: '1',
      title: 'Long',
      body: { storage: { value: `<p>${'x'.repeat(5000)}</p>` } },
    },
  });
  const body = text(
    await callTool('confluence_get_page', { pageId: '1' }, { ...context, maxBodyCharacters: 1000 }),
  );
  assert.match(body, /… truncated 4,000 more characters/);
});

// ------------------------------------------------------------------ plumbing

test('Cloud switches endpoint version and auth scheme', () => {
  assert.ok(isCloudUrl('https://site.atlassian.net/wiki'));
  assert.ok(!isCloudUrl('https://jira.internal.example.com'));
  assert.equal(authorizationHeader({ baseUrl: 'x', token: 'tok' }), 'Bearer tok');
  assert.equal(
    authorizationHeader({ baseUrl: 'x', token: 'tok', username: 'me@example.com' }),
    `Basic ${Buffer.from('me@example.com:tok').toString('base64')}`,
  );
});

test('a Cloud Jira search uses the search/jql endpoint', async () => {
  const connections = {
    jira: { baseUrl: 'https://site.atlassian.net', token: 'tok', username: 'me@example.com' },
  };
  const fetchImpl = fakeFetch({ '/rest/api/3/search/jql': { issues: [] } });
  const context = {
    client: new AtlassianClient({ connections, fetchImpl }),
    connections,
    envFile: '/tmp/x',
  };
  await callTool('jira_search', { jql: 'order by created' }, context);
  assert.deepEqual(
    fetchImpl.calls.map((call) => call.path),
    ['/rest/api/3/search/jql'],
  );
});

test('storage format is flattened into readable text', () => {
  const flattened = storageToText(
    '<h2>Overview</h2><p>Uses the <code>B</code> slot.</p><ul><li>Free space &gt; 512&nbsp;MB</li></ul>' +
      '<ac:structured-macro ac:name="note"><ac:parameter ac:name="title">Careful</ac:parameter>' +
      '<ac:rich-text-body><p>Never skip it.</p></ac:rich-text-body></ac:structured-macro>' +
      '<p>See <ac:link><ri:page ri:content-title="Signing" /></ac:link>.</p>' +
      '<script>alert(1)</script><!-- hidden -->',
  );
  assert.match(flattened, /## Overview/);
  assert.match(flattened, /Uses the B slot\./);
  assert.match(flattened, /- Free space > 512 MB/);
  assert.match(flattened, /Never skip it\./);
  assert.match(flattened, /See Signing\./);
  // Macro configuration and non-content elements are dropped.
  assert.ok(!flattened.includes('Careful'));
  assert.ok(!flattened.includes('alert(1)'));
  assert.ok(!flattened.includes('hidden'));
  assert.ok(!flattened.includes('<'));
});

test('unknown ADF nodes degrade to their inner text', () => {
  const flattened = adfToText({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'mention', attrs: { text: '@Sang' } }] },
      { type: 'someFutureNode', content: [{ type: 'text', text: 'still here' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'text', text: 'item' }] }] },
    ],
  });
  assert.match(flattened, /Hello @Sang/);
  assert.match(flattened, /still here/);
  assert.match(flattened, /- item/);
});

test('truncate is a no-op below the limit', () => {
  assert.equal(truncate('short', 100), 'short');
});
