/**
 * Claude Code `UserPromptSubmit` hook: put the Jira ticket in front of the
 * agent before its first turn.
 *
 * Run as `node dist/atlassian-server.js --prompt-hook`. Claude Code pipes
 * `{prompt, cwd, session_id}` JSON on stdin and adds whatever the hook prints
 * to the agent's context. A tool the agent must decide to call is a tool it
 * often does not call; a ticket that is already in context is one it cannot
 * miss. This is the same front-loading `codegraph prompt-hook` does for code,
 * applied to the requirement.
 *
 * LOAD-BEARING: this must never break or slow down the user's prompt beyond a
 * few seconds. Every failure path — kill switch, no key, nothing configured,
 * wrong key, network error — exits 0 with no output.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractIssueKey, extractPromptIssueKey } from '../jira/issueKey';
import { AtlassianClient } from './client';
import { resolveConnections } from './connection';
import { buildTaskContext } from './tools';

export interface PromptHookInput {
  prompt?: string;
  cwd?: string;
  session_id?: string;
}

/**
 * Words that make a prompt about the branch's ticket even though it does not
 * name the key: the task verbs of the four workflows, in English and
 * Vietnamese. A bare "what does this function do?" on a feature branch is a
 * code question and stays a no-op.
 */
const TASK_INTENT =
  /(?<![\p{L}\p{N}_])(?:implement|implementation|build|add|fix|bug|review|ticket|task|story|issue|acceptance criteria|requirements?|spec|finish|continue|triển khai|hiện thực|làm tiếp|tiếp tục|thêm|sửa|lỗi|yêu cầu|đánh giá|kiểm tra|tiêu chí)(?![\p{L}\p{N}_])/iu;

/** Re-injecting the same ticket inside this window only repeats what the agent already has. */
const DEDUPE_WINDOW_MS = 30 * 60 * 1000;

/**
 * Which ticket, if any, this prompt is about.
 *
 * A key typed in the prompt always counts. A key in the branch name counts
 * only when the prompt reads like work on that ticket, so every other question
 * asked on a feature branch does not pay for a Jira round-trip.
 */
export function ticketForPrompt(prompt: string, branch: string | undefined): string | undefined {
  const named = extractPromptIssueKey(prompt);
  if (named) return named;
  const fromBranch = extractIssueKey(branch);
  return fromBranch && TASK_INTENT.test(prompt) ? fromBranch : undefined;
}

function currentBranch(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

interface DedupeStore {
  seen(sessionId: string | undefined, key: string, now: number): boolean;
  remember(sessionId: string | undefined, key: string, now: number): void;
}

/** Per-session record of injected tickets, in a temp file so it survives across hook processes. */
export function fileDedupeStore(directory = join(tmpdir(), 'codebrain-prompt-hook')): DedupeStore {
  const fileFor = (sessionId: string): string =>
    join(directory, `${createHash('sha1').update(sessionId).digest('hex').slice(0, 16)}.json`);
  const read = (sessionId: string): Record<string, number> => {
    try {
      return JSON.parse(readFileSync(fileFor(sessionId), 'utf8')) as Record<string, number>;
    } catch {
      return {};
    }
  };
  return {
    seen(sessionId, key, now) {
      if (!sessionId) return false;
      const at = read(sessionId)[key];
      return typeof at === 'number' && now - at < DEDUPE_WINDOW_MS;
    },
    remember(sessionId, key, now) {
      if (!sessionId) return;
      try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(fileFor(sessionId), JSON.stringify({ ...read(sessionId), [key]: now }));
      } catch {
        // Dedupe is an optimisation; a read-only temp dir only costs a repeat.
      }
    },
  };
}

export interface PromptHookOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  fetchImpl?: typeof fetch;
  branch?: (cwd: string) => string | undefined;
  dedupe?: DedupeStore;
  now?: number;
}

/**
 * The text to inject for one prompt, or `''` for "stay silent".
 *
 * Never throws: the caller prints the result and exits 0 either way.
 */
export async function promptHookOutput(
  input: PromptHookInput,
  options: PromptHookOptions = {},
): Promise<string> {
  try {
    const env = options.env ?? process.env;
    if (env.CODEBRAIN_NO_PROMPT_HOOK === '1' || env.CODEBRAIN_PROMPT_HOOK === '0') return '';
    const prompt = String(input.prompt ?? '');
    if (!prompt.trim()) return '';

    const cwd = input.cwd || process.cwd();
    const key = ticketForPrompt(prompt, (options.branch ?? currentBranch)(cwd));
    if (!key) return '';

    const dedupe = options.dedupe ?? fileDedupeStore();
    const now = options.now ?? Date.now();
    if (dedupe.seen(input.session_id, key, now)) return '';

    const { connections, envFile } = resolveConnections(env, options.home);
    if (!connections.jira) return '';

    const context = await buildTaskContext(
      { key, specLimit: 1 },
      {
        client: new AtlassianClient({ connections, fetchImpl: options.fetchImpl, timeoutMs: 5_000 }),
        connections,
        envFile,
        maxBodyCharacters: 10_000,
      },
    );
    // A key-shaped word that is not a ticket, or one the user cannot see.
    if (!context.issueLoaded) return '';

    dedupe.remember(input.session_id, key, now);
    return [
      `<codebrain_ticket_context key="${key}" note="Jira ${key} with its comments, extracted acceptance criteria and related Confluence spec, from CodeBrain Atlassian. Treat it as the requirement and as already read; call codebrain_task_context again only for a different ticket. Use codegraph_explore with the code names it lists.">`,
      context.text,
      '</codebrain_ticket_context>',
      '',
    ].join('\n');
  } catch {
    return '';
  }
}

/** Entry point: read stdin, print the injection (if any), always exit cleanly. */
export async function runPromptHook(): Promise<void> {
  if (process.stdin.isTTY) return;
  const raw = await new Promise<string>((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
  let input: PromptHookInput = {};
  try {
    input = JSON.parse(raw) as PromptHookInput;
  } catch {
    return;
  }
  const output = await promptHookOutput(input);
  if (output) process.stdout.write(output);
}
