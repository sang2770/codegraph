/**
 * A one-shot MCP stdio client: start the CodeGraph server, call one tool, stop.
 *
 * Some CodeGraph capabilities exist only as MCP tools — `codegraph_review` has
 * no CLI command — so the extension talks to the server the same way an agent
 * does, over newline-delimited JSON-RPC on stdin/stdout.
 *
 * Two details matter:
 *
 *  - **stdin stays open until the answer arrives.** The server shuts down on
 *    EOF, and a call still in flight when stdin closes is never answered.
 *  - **A tool's `isError` is not an exception.** CodeGraph reserves it for
 *    genuine malfunctions and answers expected conditions (no index, bad ref)
 *    as ordinary text, so the result carries both and the caller decides.
 *
 * No `vscode` import: this runs under plain `node --test`.
 */

import { spawn } from 'node:child_process';

const PROTOCOL_VERSION = '2025-06-18';

export interface McpToolCall {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  tool: string;
  toolArgs: Record<string, unknown>;
  timeoutMs?: number;
  /** Aborts the call and stops the server. */
  signal?: AbortSignal;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
}

export function callMcpTool(call: McpToolCall): Promise<McpToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(call.command, [...call.args], {
      cwd: call.cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...call.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let settled = false;
    let buffer = '';
    let stderr = '';

    const finish = (error: Error | undefined, result?: McpToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      call.signal?.removeEventListener('abort', onAbort);
      // Closing stdin is the server's cue to shut down cleanly; the kill is
      // the backstop for one that does not.
      child.stdin.end();
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 2000).unref();
      if (error) reject(error);
      else resolve(result!);
    };

    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };

    const timer = setTimeout(
      () => finish(new Error(`${call.tool} timed out after ${Math.round((call.timeoutMs ?? 120_000) / 1000)}s.`)),
      call.timeoutMs ?? 120_000,
    );
    const onAbort = (): void => finish(new Error(`${call.tool} was cancelled.`));
    if (call.signal?.aborted) {
      onAbort();
      return;
    }
    call.signal?.addEventListener('abort', onAbort);

    const handle = (message: {
      id?: number;
      result?: { content?: { type?: string; text?: string }[]; isError?: boolean };
      error?: { message?: string };
    }): void => {
      if (message.id === 1) {
        if (message.error) {
          finish(new Error(`MCP initialize failed: ${message.error.message ?? 'unknown error'}`));
          return;
        }
        send({ method: 'notifications/initialized' });
        send({ id: 2, method: 'tools/call', params: { name: call.tool, arguments: call.toolArgs } });
        return;
      }
      if (message.id !== 2) return;
      if (message.error) {
        finish(new Error(`${call.tool} failed: ${message.error.message ?? 'unknown error'}`));
        return;
      }
      const text = (message.result?.content ?? [])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
      finish(undefined, { text, isError: message.result?.isError === true });
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            handle(JSON.parse(line));
          } catch {
            // Not a protocol message; the server keeps diagnostics on stderr,
            // so this is only ever noise worth skipping.
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' ');
      finish(new Error(`The CodeGraph MCP server exited (code ${String(code)}) before answering${detail ? `: ${detail}` : '.'}`));
    });
    // Never let a broken pipe on a dying server surface as an uncaught error.
    child.stdin.on('error', () => {});

    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'codebrain-vscode', version: '1' },
      },
    });
  });
}
