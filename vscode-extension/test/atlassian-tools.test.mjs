import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const { AtlassianClient, authorizationHeader, isCloudUrl } =
  loadTypeScript('atlassian/client.ts');
const { adfToText, quoteQueryLiteral, storageToText, textToAdf, textToStorage, truncate } =
  loadTypeScript('atlassian/format.ts');
const {
  buildConfluenceCql,
  buildJiraJql,
  callTool,
  imageMimeType,
  listTools,
  toolNames,
} = loadTypeScript('atlassian/tools.ts');

const CONNECTIONS = {
  jira: { baseUrl: 'https://jira.example.com', token: 'jira-token' },
  confluence: { baseUrl: 'https://collab.example.com', token: 'conf-token' },
};

/** A one-pixel PNG, so a download test exercises real bytes. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A fetch stand-in that records requests and replays canned payloads keyed by
 * path. Anything unmatched answers 404, which is what the real server does and
 * what the "recoverable failure" path needs to be exercised.
 *
 * A route may be a JSON value, a Buffer (served as bytes, for attachments), an
 * Error (thrown), or a function of the recorded request — the last of which is
 * how a write test asserts on the body it was sent.
 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(url);
    const call = {
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);

    let route = routes[parsed.pathname];
    if (route === undefined) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => '{"errorMessages":["not found"]}',
      };
    }
    if (typeof route === 'function') route = route(call);
    if (route instanceof Error) throw route;
    // `null` is a 204 with no body: what Jira answers to an assign or transition.
    if (route === null) return { ok: true, status: 204, statusText: 'No Content' };
    if (Buffer.isBuffer(route)) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (name) => (name === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () => route.buffer.slice(route.byteOffset, route.byteOffset + route.byteLength),
      };
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => route };
  };
  impl.calls = calls;
  return impl;
}

function contextFor(routes, connections = CONNECTIONS, extra = {}) {
  const fetchImpl = fakeFetch(routes);
  return {
    context: {
      client: new AtlassianClient({ connections, fetchImpl }),
      connections,
      envFile: '/home/x/.codebrain/atlassian.env',
      ...extra,
    },
    fetchImpl,
  };
}

/** A context whose write tools are reachable. */
function writableContextFor(routes, connections = CONNECTIONS) {
  return contextFor(routes, connections, { allowWrite: true });
}

const text = (result) => result.content[0].text;
const images = (result) => result.content.filter((block) => block.type === 'image');

// -------------------------------------------------------------- tool listing

test('only configured products are advertised', () => {
  assert.deepEqual(toolNames({ jira: CONNECTIONS.jira }), [
    'jira_search',
    'jira_get_issue',
    'jira_get_comments',
    'jira_get_issue_images',
  ]);
  assert.deepEqual(toolNames({ confluence: CONNECTIONS.confluence }), [
    'confluence_search',
    'confluence_get_page',
    'confluence_get_page_images',
  ]);
  assert.equal(toolNames(CONNECTIONS).length, 7);
  // Nothing configured still lists everything, so the reply can explain how to
  // configure it instead of the server looking broken.
  assert.equal(toolNames({}).length, 7);
});

test('write tools are invisible until write access is enabled', () => {
  const readOnly = toolNames(CONNECTIONS);
  for (const name of [
    'jira_add_comment',
    'jira_get_transitions',
    'jira_transition_issue',
    'jira_assign_issue',
    'confluence_create_page',
    'confluence_update_page',
    'confluence_add_comment',
  ]) {
    assert.ok(!readOnly.includes(name), `${name} must not be listed without write access`);
  }

  const writable = toolNames(CONNECTIONS, { allowWrite: true });
  assert.equal(writable.length, 14);
  for (const name of readOnly) assert.ok(writable.includes(name), `${name} should still be listed`);
  // Jira-only setups still never see Confluence write tools.
  const jiraOnly = toolNames({ jira: CONNECTIONS.jira }, { allowWrite: true });
  assert.ok(jiraOnly.includes('jira_add_comment'));
  assert.ok(!jiraOnly.some((name) => name.startsWith('confluence_')));
});

test('every tool declares an object schema and no internal fields leak', () => {
  for (const tool of listTools(CONNECTIONS, { allowWrite: true })) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 40, `${tool.name} needs a real description`);
    assert.equal(tool.product, undefined);
    assert.equal(tool.write, undefined);
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

// -------------------------------------------------------------------- images

test('jira_get_issue_images returns the image inline and names what it skipped', async () => {
  const { context, fetchImpl } = contextFor({
    '/rest/api/2/issue/ABC-1234': {
      key: 'ABC-1234',
      fields: {
        attachment: [
          {
            id: '1',
            filename: 'crash.png',
            mimeType: 'image/png',
            size: 68,
            created: '2026-08-21T10:00:00.000+0000',
            author: { displayName: 'QA' },
            content: 'https://jira.example.com/secure/attachment/1/crash.png',
          },
          {
            id: '2',
            filename: 'logcat.txt',
            mimeType: 'text/plain',
            size: 400,
            content: 'https://jira.example.com/secure/attachment/2/logcat.txt',
          },
          {
            id: '3',
            filename: 'huge.png',
            mimeType: 'image/png',
            size: 20 * 1024 * 1024,
            content: 'https://jira.example.com/secure/attachment/3/huge.png',
          },
        ],
      },
    },
    '/secure/attachment/1/crash.png': PNG_BYTES,
  });

  const result = await callTool('jira_get_issue_images', { key: 'ABC-1234' }, context);
  const blocks = images(result);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].mimeType, 'image/png');
  assert.equal(blocks[0].data, PNG_BYTES.toString('base64'));
  assert.match(text(result), /1 returned of 2 image attachment/);
  assert.match(text(result), /crash\.png — image\/png · 68 B · added 2026-08-21 10:00 by QA/);
  assert.match(text(result), /huge\.png — skipped, 20\.0 MB is over the 4\.0 MB per-image limit/);
  // The oversize file is never downloaded, and the .txt is not even considered.
  assert.deepEqual(
    fetchImpl.calls.map((call) => call.path),
    ['/rest/api/2/issue/ABC-1234', '/secure/attachment/1/crash.png'],
  );
});

test('an issue with no image attachments points at the text instead', async () => {
  const { context } = contextFor({
    '/rest/api/2/issue/ABC-1': {
      key: 'ABC-1',
      fields: { attachment: [{ filename: 'trace.log', mimeType: 'text/plain' }] },
    },
  });
  const result = await callTool('jira_get_issue_images', { key: 'ABC-1' }, context);
  assert.equal(result.isError, undefined);
  assert.match(text(result), /1 attachment\(s\), none of them images: trace\.log/);
  assert.match(text(result), /Use jira_get_issue/);
});

test('confluence_get_page_images resolves the download link against the context path', async () => {
  const connections = {
    confluence: { baseUrl: 'https://site.atlassian.net/wiki', token: 'tok', username: 'me@x.com' },
  };
  const { context, fetchImpl } = contextFor(
    {
      '/wiki/rest/api/content/556677/child/attachment': {
        results: [
          {
            id: 'att1',
            title: 'flow.png',
            metadata: { mediaType: 'image/png' },
            extensions: { fileSize: 68 },
            _links: { download: '/download/attachments/556677/flow.png?version=1' },
          },
        ],
      },
      '/wiki/download/attachments/556677/flow.png': PNG_BYTES,
    },
    connections,
  );

  const result = await callTool('confluence_get_page_images', { pageId: '556677' }, context);
  assert.equal(images(result).length, 1);
  // The /wiki context path survives; without it Confluence Cloud answers 404.
  assert.equal(fetchImpl.calls[1].path, '/wiki/download/attachments/556677/flow.png');
  assert.equal(fetchImpl.calls[1].query.version, '1');
});

test('an attachment pointing at another host never receives the token', async () => {
  const { context } = contextFor({
    '/rest/api/2/issue/ABC-1': {
      key: 'ABC-1',
      fields: {
        attachment: [
          { filename: 'shot.png', mimeType: 'image/png', content: 'https://evil.example.net/shot.png' },
        ],
      },
    },
  });
  const result = await callTool('jira_get_issue_images', { key: 'ABC-1' }, context);
  assert.equal(images(result).length, 0);
  assert.match(text(result), /Refusing to send credentials to evil\.example\.net/);
});

test('an ambiguously typed upload is still recognised by its extension', () => {
  assert.equal(imageMimeType('shot.PNG', 'application/octet-stream'), 'image/png');
  assert.equal(imageMimeType('shot.jpg', ''), 'image/jpeg');
  assert.equal(imageMimeType('photo.jpeg', 'image/jpg'), 'image/jpeg');
  assert.equal(imageMimeType('diagram.png', 'image/png; charset=binary'), 'image/png');
  // A specific non-image type wins over a misleading extension.
  assert.equal(imageMimeType('report.png', 'application/pdf'), undefined);
  assert.equal(imageMimeType('notes.txt', 'text/plain'), undefined);
  assert.equal(imageMimeType(undefined, undefined), undefined);
});

// --------------------------------------------------------------------- writes

test('a write tool named while writing is off explains how to enable it', async () => {
  const { context, fetchImpl } = contextFor({});
  const result = await callTool('jira_add_comment', { key: 'ABC-1', body: 'hi' }, context);
  assert.equal(result.isError, undefined);
  assert.match(text(result), /write access is turned off/);
  assert.match(text(result), /CODEBRAIN_ATLASSIAN_ALLOW_WRITE=1/);
  assert.match(text(result), /do not retry any write tool in this session/);
  // Nothing reaches Jira: the guard is before the request, not after it.
  assert.equal(fetchImpl.calls.length, 0);
});

test('jira_add_comment posts plain text on Server and ADF on Cloud', async () => {
  const { context, fetchImpl } = writableContextFor({
    '/rest/api/2/issue/ABC-1/comment': { id: '900' },
  });
  const result = await callTool(
    'jira_add_comment',
    { key: 'ABC-1', body: 'Fixed in abc1234.' },
    context,
  );
  assert.equal(fetchImpl.calls[0].method, 'POST');
  assert.equal(fetchImpl.calls[0].body.body, 'Fixed in abc1234.');
  assert.match(text(result), /Comment posted on ABC-1 \(id 900\)/);
  assert.match(text(result), /focusedCommentId=900/);

  const cloud = { jira: { baseUrl: 'https://site.atlassian.net', token: 'tok', username: 'me@x.com' } };
  const cloudCall = contextFor({ '/rest/api/3/issue/ABC-1/comment': { id: '5' } }, cloud, {
    allowWrite: true,
  });
  await callTool('jira_add_comment', { key: 'ABC-1', body: 'Line one\n\nLine two' }, cloudCall.context);
  assert.deepEqual(cloudCall.fetchImpl.calls[0].body.body, textToAdf('Line one\n\nLine two'));
});

test('jira_transition_issue matches a target status and reports where it landed', async () => {
  const { context, fetchImpl } = writableContextFor({
    '/rest/api/2/issue/ABC-1/transitions': { transitions: [{ id: '31', name: 'Start Progress', to: { name: 'In Progress' } }] },
    '/rest/api/2/issue/ABC-1': { key: 'ABC-1', fields: { status: { name: 'In Progress' } } },
  });

  // "In Progress" is the target status, not the transition name — both work.
  const result = await callTool(
    'jira_transition_issue',
    { key: 'ABC-1', transition: 'in progress', comment: 'Picking this up.' },
    context,
  );
  const post = fetchImpl.calls.find((call) => call.method === 'POST');
  assert.equal(post.body.transition.id, '31');
  assert.equal(post.body.update.comment[0].add.body, 'Picking this up.');
  assert.match(text(result), /transitioned via "Start Progress"\. Status is now In Progress/);
});

test('an unavailable transition answers with the ones that are', async () => {
  const { context, fetchImpl } = writableContextFor({
    '/rest/api/2/issue/ABC-1/transitions': {
      transitions: [{ id: '31', name: 'Start Progress', to: { name: 'In Progress' }, hasScreen: true }],
    },
  });
  const result = await callTool('jira_transition_issue', { key: 'ABC-1', transition: 'Done' }, context);
  assert.equal(result.isError, undefined);
  assert.match(text(result), /"Done" is not available on ABC-1/);
  assert.match(text(result), /- Start Progress → In Progress \[id 31\] \(opens a screen/);
  assert.ok(!fetchImpl.calls.some((call) => call.method === 'POST'), 'nothing may be transitioned');
});

test('jira_assign_issue resolves "me" and survives a 204 with no body', async () => {
  const { context, fetchImpl } = writableContextFor({
    '/rest/api/2/myself': { name: 'sang', displayName: 'Sang Nguyen', emailAddress: 's@x.com' },
    '/rest/api/2/issue/ABC-1/assignee': null,
  });
  const result = await callTool('jira_assign_issue', { key: 'ABC-1', assignee: 'me' }, context);
  const put = fetchImpl.calls.find((call) => call.method === 'PUT');
  // Server/DC identifies a user by name; sending accountId there silently no-ops.
  assert.deepEqual(put.body, { name: 'sang' });
  assert.match(text(result), /ABC-1 is now assigned to Sang Nguyen/);
});

test('an ambiguous assignee is handed back as candidates rather than guessed', async () => {
  const { context, fetchImpl } = writableContextFor({
    '/rest/api/2/user/search': [
      { name: 'sang1', displayName: 'Sang A', active: true },
      { name: 'sang2', displayName: 'Sang B', active: true },
    ],
  });
  const result = await callTool('jira_assign_issue', { key: 'ABC-1', assignee: 'Sang' }, context);
  assert.equal(result.isError, undefined);
  assert.match(text(result), /matches 2 users/);
  assert.match(text(result), /Sang A/);
  assert.ok(!fetchImpl.calls.some((call) => call.method === 'PUT'), 'nobody may be assigned');
});

test('unassigning clears the field without a directory lookup', async () => {
  const { context, fetchImpl } = writableContextFor({ '/rest/api/2/issue/ABC-1/assignee': null });
  const result = await callTool('jira_assign_issue', { key: 'ABC-1', assignee: 'unassigned' }, context);
  assert.match(text(result), /ABC-1 is now unassigned/);
  assert.deepEqual(fetchImpl.calls[0].body, { name: null });
});

test('confluence_create_page converts the body to storage format', async () => {
  const { context, fetchImpl } = writableContextFor({
    '/rest/api/content': { id: '99', title: 'Rollback', _links: { webui: '/display/PLATFORM/Rollback' } },
  });
  const result = await callTool(
    'confluence_create_page',
    {
      spaceKey: 'PLATFORM',
      title: 'Rollback',
      body: '## Steps\n\n- Flash B slot\n- Reboot\n\n```sh\nota --rollback\n```',
      parentId: '556677',
    },
    context,
  );

  const sent = fetchImpl.calls[0].body;
  assert.equal(sent.type, 'page');
  assert.deepEqual(sent.ancestors, [{ id: '556677' }]);
  assert.equal(sent.body.storage.representation, 'storage');
  assert.match(sent.body.storage.value, /<h2>Steps<\/h2><ul><li>Flash B slot<\/li><li>Reboot<\/li><\/ul>/);
  assert.match(sent.body.storage.value, /<!\[CDATA\[ota --rollback\]\]>/);
  assert.match(text(result), /pageId: 99/);
  assert.match(text(result), /URL: https:\/\/collab\.example\.com\/display\/PLATFORM\/Rollback/);
});

test('confluence_update_page appends onto the current body and bumps the version', async () => {
  const { context, fetchImpl } = writableContextFor({
    '/rest/api/content/1': (call) =>
      call.method === 'GET'
        ? { id: '1', type: 'page', title: 'Notes', version: { number: 7 }, body: { storage: { value: '<p>Old</p>' } } }
        : { id: '1', title: 'Notes', version: { number: 8 } },
  });
  const result = await callTool(
    'confluence_update_page',
    { pageId: '1', body: 'New line', versionMessage: 'ABC-1' },
    context,
  );

  const put = fetchImpl.calls.find((call) => call.method === 'PUT');
  assert.equal(put.body.version.number, 8);
  assert.equal(put.body.version.message, 'ABC-1');
  assert.equal(put.body.body.storage.value, '<p>Old</p><p>New line</p>');
  assert.match(text(result), /Version 7 → 8/);
});

test('a page edited by someone else is refused instead of overwritten', async () => {
  const { context, fetchImpl } = writableContextFor({
    '/rest/api/content/1': { id: '1', type: 'page', title: 'Notes', version: { number: 9 }, body: { storage: { value: '' } } },
  });
  const result = await callTool(
    'confluence_update_page',
    { pageId: '1', body: 'x', mode: 'replace', expectedVersion: 7 },
    context,
  );
  assert.equal(result.isError, undefined);
  assert.match(text(result), /at version 9, not the expected 7/);
  assert.match(text(result), /reapply the change on top of their edit/);
  assert.ok(!fetchImpl.calls.some((call) => call.method === 'PUT'), 'nothing may be written');
});

test('a bad mode or body format is guidance, not a request', async () => {
  const { context, fetchImpl } = writableContextFor({});
  assert.match(
    text(await callTool('confluence_update_page', { pageId: '1', body: 'x', mode: 'overwrite' }, context)),
    /mode must be "append", "prepend" or "replace"/,
  );
  assert.match(
    text(await callTool('confluence_add_comment', { pageId: '1', body: 'x', bodyFormat: 'markdown' }, context)),
    /bodyFormat must be "text" or "storage"/,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('raw storage passes through untouched when asked for', async () => {
  const { context, fetchImpl } = writableContextFor({ '/rest/api/content': { id: '2' } });
  await callTool(
    'confluence_add_comment',
    { pageId: '1', body: '<p>Already <b>markup</b></p>', bodyFormat: 'storage' },
    context,
  );
  assert.equal(fetchImpl.calls[0].body.body.storage.value, '<p>Already <b>markup</b></p>');
  assert.equal(fetchImpl.calls[0].body.container.id, '1');
});

test('written text is escaped, so a body cannot inject markup', () => {
  assert.equal(
    textToStorage('A <script>alert(1)</script> & "quoted"'),
    '<p>A &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;</p>',
  );
  assert.equal(textToStorage('**bold** and `code`'), '<p><strong>bold</strong> and <code>code</code></p>');
  // A code fence keeps its content byte-exact, including the CDATA terminator.
  assert.match(textToStorage('```\na]]>b\n```'), /a\]\]\]\]><!\[CDATA\[>b/);
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
