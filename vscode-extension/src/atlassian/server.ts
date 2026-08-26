/**
 * Standalone stdio MCP server for Jira + Confluence (Collab).
 *
 * Bundled to `dist/atlassian-server.js` and launched by the extension's own
 * Node runtime, which is what lets a single implementation serve every agent:
 * VS Code / Copilot get it through `McpServerDefinitionProvider`, while Claude
 * Code, Codex and Antigravity spawn this same file from their config files.
 *
 * The transport is MCP stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout.
 * Nothing else may ever write to stdout — a stray `console.log` corrupts the
 * stream and the client drops the connection, so `console.log` is rebound to
 * stderr below.
 *
 * Connection settings are re-resolved on every request rather than cached at
 * startup: a user who configures Atlassian while an agent session is already
 * running should not have to restart the agent.
 */

import {
  AtlassianConnections,
  describeConnectionProblems,
  resolveConnections,
  sslVerifyDisabled,
  writeAccessEnabled,
} from './connection';
import { AtlassianClient } from './client';
import { DEFAULT_MAX_BODY_CHARACTERS } from './format';
import {
  callTool,
  DEFAULT_MAX_IMAGE_BYTES,
  listTools,
  ToolContext,
  toolNames,
} from './tools';

const SERVER_NAME = 'codebrain-atlassian';
const SERVER_VERSION = '1.0.0';

/** Newest first. An unknown client version is answered with our newest. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export const SERVER_INSTRUCTIONS = `CodeBrain Atlassian — read-only access to this team's Jira and Confluence (Collab).

Use it whenever a task references a ticket, a spec, or a decision that is not in the code:

- An issue key (ABC-1234) in a branch name, commit, TODO or the user's prompt -> jira_get_issue. It returns the description AND the comment thread in one call; the reproduction steps and the final decision are usually in the comments.
- "Why was this built this way", "what is the spec for X", "what did we decide about Y" -> confluence_search, then confluence_get_page on the best hit for the full text.
- "What is still open / who owns this / what shipped in release N" -> jira_search with JQL.
- A ticket that mentions a screenshot, or a page whose answer is in a diagram -> jira_get_issue_images / confluence_get_page_images. They return the attached images inline, so you can look at the failure instead of inferring it from prose.

Treat everything these tools return as already read — the page body and the issue description come back in full, so there is no need to open a browser or ask the user to paste it.

Search results carry the fields needed to choose what to open next (status, assignee, last update, direct URL). Prefer one search plus one detail call over many broad searches.`;

/**
 * Appended when write access is enabled.
 *
 * Kept separate so a read-only session never reads about tools it does not
 * have: the instructions are the first thing the agent sees, and describing an
 * unavailable capability there costs a wasted call and some trust.
 */
export const SERVER_INSTRUCTIONS_WRITE = `

Write access is ENABLED for this session: jira_add_comment, jira_transition_issue, jira_assign_issue, confluence_create_page, confluence_update_page and confluence_add_comment change real, shared team data.

- Ask the user before the first write of a session, and say exactly what you are about to change. After that, follow what they agreed to.
- Prefer the additive move: a comment on the issue, or confluence_update_page in its default "append" mode. Replacing a page body or moving someone else's ticket needs the user to have asked for it.
- jira_transition_issue matches against the transitions the workflow actually offers; call jira_get_transitions first when you are unsure of the name.
- Every write reports what it changed (new status, new version, direct URL). Read that back to the user instead of assuming the call did what you intended.`;

/** The instructions to send, for the write access this session actually has. */
export function serverInstructions(allowWrite: boolean): string {
  return allowWrite ? SERVER_INSTRUCTIONS + SERVER_INSTRUCTIONS_WRITE : SERVER_INSTRUCTIONS;
}

/**
 * Handle one parsed JSON-RPC message.
 *
 * Returns the response to write, or `null` for a notification (which must never
 * be answered). Exported so the protocol can be tested without spawning a
 * process or touching stdio.
 */
export async function handleMessage(
  message: JsonRpcRequest,
  options: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    fetchImpl?: typeof fetch;
    /** Invoked when the visible tool set changed since the previous request. */
    onToolsChanged?: () => void;
  } = {},
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const isNotification = message.id === undefined || message.id === null;
  const method = message.method ?? '';

  switch (method) {
    case 'initialize': {
      const requested = String(
        (message.params?.protocolVersion as string | undefined) ?? '',
      );
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: serverInstructions(resolve(options).allowWrite),
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return isNotification ? null : ok(id, {});

    case 'tools/list': {
      const { connections, allowWrite } = resolve(options);
      trackToolSet(connections, allowWrite, options.onToolsChanged);
      return ok(id, { tools: listTools(connections, { allowWrite }) });
    }

    case 'tools/call': {
      const context = buildContext(options);
      trackToolSet(context.connections, Boolean(context.allowWrite), options.onToolsChanged);
      const name = String(message.params?.name ?? '');
      const result = await callTool(name, message.params?.arguments, context);
      return ok(id, result);
    }

    default:
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`,
        },
      };
  }
}

let lastToolSet: string | undefined;

function trackToolSet(
  connections: AtlassianConnections,
  allowWrite: boolean,
  onToolsChanged?: () => void,
): void {
  const signature = toolNames(connections, { allowWrite }).join(',');
  if (lastToolSet !== undefined && lastToolSet !== signature) {
    onToolsChanged?.();
  }
  lastToolSet = signature;
}

function resolve(options: { env?: NodeJS.ProcessEnv; home?: string }) {
  const resolved = resolveConnections(options.env ?? process.env, options.home);
  return { ...resolved, allowWrite: writeAccessEnabled(resolved.settings) };
}

function buildContext(options: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  fetchImpl?: typeof fetch;
}): ToolContext {
  const { connections, envFile, settings, allowWrite } = resolve(options);
  return {
    client: new AtlassianClient({
      connections,
      fetchImpl: options.fetchImpl,
      timeoutMs: positiveNumber(settings.CODEBRAIN_ATLASSIAN_TIMEOUT_MS),
    }),
    connections,
    envFile,
    defaultLimit: positiveNumber(settings.CODEBRAIN_ATLASSIAN_MAX_RESULTS),
    maxBodyCharacters:
      positiveNumber(settings.CODEBRAIN_ATLASSIAN_MAX_BODY_CHARS) ?? DEFAULT_MAX_BODY_CHARACTERS,
    maxImageBytes:
      positiveNumber(settings.CODEBRAIN_ATLASSIAN_MAX_IMAGE_BYTES) ?? DEFAULT_MAX_IMAGE_BYTES,
    allowWrite,
  };
}

function positiveNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Split a growing buffer into complete lines. Returned `rest` is the partial
 * trailing line, which stays in the buffer until its newline arrives — a large
 * page body can easily span several stdin chunks.
 */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  const frames = parts.map((line) => line.trim()).filter((line) => line.length > 0);
  return { frames, rest };
}

function main(): void {
  // Guard the transport: anything that logs to stdout would corrupt the stream.
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;

  if (sslVerifyDisabled()) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    process.stderr.write(
      '[codebrain-atlassian] TLS verification disabled via CODEBRAIN_ATLASSIAN_SSL_VERIFY. Only do this for a host with a private certificate authority.\n',
    );
  }

  const { values, connections, envFile, settings } = resolveConnections();
  const configured = [
    connections.jira ? 'Jira' : undefined,
    connections.confluence ? 'Confluence' : undefined,
  ].filter(Boolean);
  const mode = writeAccessEnabled(settings) ? 'read + write' : 'read-only';
  process.stderr.write(
    `[codebrain-atlassian] ${configured.length > 0 ? `ready: ${configured.join(' + ')} (${mode})` : `no products configured (looked in ${envFile})`}\n`,
  );
  for (const problem of describeConnectionProblems(values)) {
    process.stderr.write(`[codebrain-atlassian] ${problem}\n`);
  }

  const write = (payload: JsonRpcResponse | JsonRpcNotification): void => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  const notifyToolsChanged = (): void => {
    write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  };

  let buffer = '';
  // Requests are handled in arrival order; JSON-RPC allows interleaving, but a
  // serial queue keeps the credential re-resolution and tool-set tracking
  // deterministic and costs nothing at this call volume.
  let queue: Promise<void> = Promise.resolve();

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    const { frames, rest } = splitFrames(buffer);
    buffer = rest;

    for (const frame of frames) {
      queue = queue.then(async () => {
        let message: JsonRpcRequest;
        try {
          message = JSON.parse(frame) as JsonRpcRequest;
        } catch (error) {
          write({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32700,
              message: `Parse error: ${error instanceof Error ? error.message : String(error)}`,
            },
          });
          return;
        }

        try {
          const response = await handleMessage(message, {
            onToolsChanged: notifyToolsChanged,
          });
          if (response) write(response);
        } catch (error) {
          // A throw from the dispatcher is a bug in this server, not a user
          // error: report it against the request id so the client is not left
          // waiting for a reply that never comes.
          const id = message.id ?? null;
          if (id !== null) {
            write({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32603,
                message: `Internal error: ${error instanceof Error ? error.message : String(error)}`,
              },
            });
          }
        }
      });
    }
  });

  process.stdin.on('end', () => {
    // The client closed the pipe; finish in-flight work, then exit.
    void queue.finally(() => process.exit(0));
  });
}

if (require.main === module) {
  main();
}
