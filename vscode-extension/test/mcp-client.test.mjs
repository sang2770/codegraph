import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTypeScript } from './helpers/load.mjs';

const { callMcpTool } = loadTypeScript('mcpClient.ts');
const { reviewArguments } = loadTypeScript('codegraphReview.ts', { vscode: {} });

/**
 * A fake MCP server. Like the real one it only answers while stdin is open:
 * the reply to tools/call is delayed, and it quits the moment stdin ends.
 */
function fakeServer(behaviour) {
  const dir = mkdtempSync(join(tmpdir(), 'codebrain-mcp-'));
  const script = join(dir, 'server.js');
  writeFileSync(
    script,
    `const behaviour = ${JSON.stringify(behaviour)};
let buffer = '';
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    const reply = (body) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...body }) + '\\n');
    if (message.method === 'initialize') {
      process.stdout.write('not json, just noise\\n');
      reply({ result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
    } else if (message.method === 'tools/call') {
      if (behaviour === 'crash') { process.stderr.write('boom: index locked\\n'); process.exit(3); }
      if (behaviour === 'hang') return;
      setTimeout(() => reply({ result: {
        content: [{ type: 'text', text: 'called ' + message.params.name + ' ' + JSON.stringify(message.params.arguments) }],
        isError: behaviour === 'tool-error',
      } }), 200);
    }
  }
});
`,
  );
  return { script, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const call = (script, extra = {}) =>
  callMcpTool({
    command: process.execPath,
    args: [script],
    cwd: tmpdir(),
    tool: 'codegraph_review',
    toolArgs: { base: 'HEAD' },
    timeoutMs: 5000,
    ...extra,
  });

test('a tool call is answered even though the server quits on EOF', async () => {
  const server = fakeServer('ok');
  try {
    const result = await call(server.script);
    assert.equal(result.isError, false);
    assert.equal(result.text, 'called codegraph_review {"base":"HEAD"}');
  } finally {
    server.cleanup();
  }
});

test('a tool-level error comes back as data, not an exception', async () => {
  const server = fakeServer('tool-error');
  try {
    assert.equal((await call(server.script)).isError, true);
  } finally {
    server.cleanup();
  }
});

test('a server that dies before answering is reported with its stderr', async () => {
  const server = fakeServer('crash');
  try {
    await assert.rejects(call(server.script), /exited \(code 3\).*index locked/);
  } finally {
    server.cleanup();
  }
});

test('a hung server times out, and cancellation stops it', async () => {
  const server = fakeServer('hang');
  try {
    await assert.rejects(call(server.script, { timeoutMs: 300 }), /timed out/);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    await assert.rejects(call(server.script, { signal: abort.signal }), /cancelled/);
  } finally {
    server.cleanup();
  }
});

test('review refs: HEAD for the working tree, the parent for a commit', () => {
  assert.deepEqual(reviewArguments('/repo', {}, ['a.ts']), {
    projectPath: '/repo',
    format: 'markdown',
    base: 'HEAD',
  });
  assert.deepEqual(reviewArguments('/repo', { commit: { hash: 'abc', parent: 'def' } }, ['a.ts']), {
    projectPath: '/repo',
    format: 'markdown',
    base: 'def',
    head: 'abc',
  });
  // A root commit has nothing to compare with; review its files instead.
  assert.deepEqual(reviewArguments('/repo', { commit: { hash: 'abc' } }, ['a.ts']), {
    projectPath: '/repo',
    format: 'markdown',
    files: ['a.ts'],
  });
});
