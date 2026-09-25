import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const { definitionVersion } = loadTypeScript('mcpProvider.ts', { vscode: {} });

const base = ['2.1.1', '/rt/1.6.1/node', ['entry.js', 'serve', '--mcp'], { CODEGRAPH_WATCH_DEBOUNCE_MS: '1000' }];

test('the definition version moves whenever what the server offers moves', () => {
  const version = definitionVersion(...base);
  assert.match(version, /^2\.1\.1\+[0-9a-f]{10}$/);
  assert.equal(definitionVersion(...base), version, 'stable for the same definition');

  // A new tool surface — the change VS Code otherwise never notices, keeping
  // the running server and its cached one-tool list.
  const withReview = { ...base[3], CODEGRAPH_MCP_TOOLS: 'explore,review' };
  assert.notEqual(definitionVersion(base[0], base[1], base[2], withReview), version);
  // A runtime update moves the command path.
  assert.notEqual(definitionVersion(base[0], '/rt/1.7.0/node', base[2], base[3]), version);
  assert.notEqual(definitionVersion('2.1.2', base[1], base[2], base[3]), version);
});

test('secret values never feed the version string', () => {
  const env = (token) => ({ JIRA_URL: 'https://jira', JIRA_PERSONAL_TOKEN: token });
  assert.equal(
    definitionVersion('1', 'node', ['server.js'], env('first')),
    definitionVersion('1', 'node', ['server.js'], env('second')),
  );
});
