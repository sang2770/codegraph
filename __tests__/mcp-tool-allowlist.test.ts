/**
 * CODEGRAPH_MCP_TOOLS allowlist — lets an operator (or an A/B harness) trim the
 * exposed MCP tool surface without touching the client config. Inert when unset.
 * Filtering happens in ListTools (getTools) and is enforced again on execute().
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolHandler } from '../src/mcp/tools';

const ENV = 'CODEGRAPH_MCP_TOOLS';
const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

describe('CODEGRAPH_MCP_TOOLS allowlist', () => {
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  const listed = () => new ToolHandler(null).getTools().map(t => t.name).sort();

  it('exposes ONLY codegraph_explore by default when unset', () => {
    delete process.env[ENV];
    // The default set (see DEFAULT_MCP_TOOLS) is pared to explore alone — the one
    // tool that earns its place (verbatim source grouped by file).
    // node/search/callers/callees/impact/files/status stay defined and executable
    // but unlisted; CODEGRAPH_MCP_TOOLS re-enables them.
    expect(listed()).toEqual(['codegraph_explore']);
  });

  it('re-enables an unlisted tool via the allowlist (impact)', () => {
    process.env[ENV] = 'explore,impact';
    expect(listed()).toEqual(['codegraph_explore', 'codegraph_impact']);
  });

  it('filters ListTools to the allowlisted short names', () => {
    process.env[ENV] = 'explore,search,node';
    expect(listed()).toEqual(['codegraph_explore', 'codegraph_node', 'codegraph_search']);
  });

  it('accepts fully-qualified codegraph_ names and ignores whitespace', () => {
    process.env[ENV] = ' codegraph_explore , search ';
    expect(listed()).toEqual(['codegraph_explore', 'codegraph_search']);
  });

  it('treats an empty/whitespace value as unset (default surface)', () => {
    process.env[ENV] = '   ';
    expect(listed()).toEqual(['codegraph_explore']);
  });

  it('rejects a disabled tool on execute (defense in depth)', async () => {
    process.env[ENV] = 'node';
    const res = await new ToolHandler(null).execute('codegraph_explore', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/disabled via CODEGRAPH_MCP_TOOLS/);
  });

  it('lets an allowlisted tool past the guard', async () => {
    process.env[ENV] = 'search';
    // No CodeGraph attached, so it fails *after* the allowlist guard — the
    // "disabled" message must NOT appear, proving the guard passed it through.
    const res = await new ToolHandler(null).execute('codegraph_search', { query: 'x' });
    expect(res.content[0].text).not.toMatch(/disabled via CODEGRAPH_MCP_TOOLS/);
  });

  it('keeps an UNLISTED tool callable when nothing was selected', async () => {
    // The default surface trims what agents are SHOWN; it must never trim what
    // a client that names a tool can CALL (library users, the CLI and the MCP
    // integration tests all depend on this).
    delete process.env[ENV];
    const res = await new ToolHandler(null).execute('codegraph_search', { query: 'x' });
    expect(res.content[0].text).not.toMatch(/disabled via CODEGRAPH_MCP_TOOLS/);
  });
});

/**
 * CODEGRAPH_MCP_PROFILE — a named surface for a non-coding integration. It must
 * change what a THIRD-PARTY client sees without widening the default surface a
 * coding agent gets (every extra listed tool measurably steers mis-picks).
 */
describe('CODEGRAPH_MCP_PROFILE=review', () => {
  const PROFILE = 'CODEGRAPH_MCP_PROFILE';
  const originalProfile = process.env[PROFILE];
  const originalTools = process.env[ENV];
  afterEach(() => {
    if (originalProfile === undefined) delete process.env[PROFILE];
    else process.env[PROFILE] = originalProfile;
    if (originalTools === undefined) delete process.env[ENV];
    else process.env[ENV] = originalTools;
  });

  const listed = () => new ToolHandler(null).getTools().map(t => t.name).sort();

  it('is inert by default — the coding surface stays at one tool', () => {
    delete process.env[PROFILE];
    delete process.env[ENV];
    expect(listed()).toEqual(['codegraph_explore']);
  });

  it('exposes review alongside explore', () => {
    delete process.env[ENV];
    process.env[PROFILE] = 'review';
    expect(listed()).toEqual(['codegraph_explore', 'codegraph_review']);
  });

  it('is case/whitespace tolerant and ignores an unknown profile', () => {
    delete process.env[ENV];
    process.env[PROFILE] = ' Review ';
    expect(listed()).toEqual(['codegraph_explore', 'codegraph_review']);
    process.env[PROFILE] = 'nonsense';
    expect(listed()).toEqual(['codegraph_explore']);
  });

  it('yields to an explicit CODEGRAPH_MCP_TOOLS allowlist', () => {
    process.env[PROFILE] = 'review';
    process.env[ENV] = 'search';
    expect(listed()).toEqual(['codegraph_search']);
  });

  it('restricts execute() to the profile surface', async () => {
    delete process.env[ENV];
    process.env[PROFILE] = 'review';
    const denied = await new ToolHandler(null).execute('codegraph_impact', { symbol: 'x' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/disabled/);

    const allowed = await new ToolHandler(null).execute('codegraph_review', {});
    expect(allowed.content[0].text).not.toMatch(/disabled/);
  });
});

/**
 * `serve --tools <list>` — the installer's review-tool option writes this arg
 * (it survives every agent's config format, where an env block does not), so
 * it must select the same surface CODEGRAPH_MCP_TOOLS does, end to end.
 */
describe('serve --tools', () => {
  let tempDir: string | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;

  afterEach(async () => {
    if (child) {
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      child = null;
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    tempDir = null;
  });

  async function listedBy(args: string[]): Promise<string[]> {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-serve-tools-'));
    const env = { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' };
    delete env[ENV];
    delete env.CODEGRAPH_MCP_PROFILE;
    child = spawn(process.execPath, [BIN, 'serve', '--mcp', ...args], {
      cwd: tempDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    }) as ChildProcessWithoutNullStreams;

    const response = new Promise<Record<string, any>>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('timeout waiting for tools/list')), 15000);
      child!.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        for (const line of buf.split('\n')) {
          try {
            const msg = JSON.parse(line);
            if (msg.id === 2) { clearTimeout(timer); resolve(msg); }
          } catch { /* partial line or noise */ }
        }
      });
    });
    const send = (msg: object) => child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    send({ id: 2, method: 'tools/list' });
    const res = await response;
    return (res.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
  }

  it('lists review alongside explore', async () => {
    expect(await listedBy(['--tools', 'explore,review'])).toEqual(['codegraph_explore', 'codegraph_review']);
  });

  it('keeps the default explore-only surface without the flag', async () => {
    expect(await listedBy([])).toEqual(['codegraph_explore']);
  });
});
