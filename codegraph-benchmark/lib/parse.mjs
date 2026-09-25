#!/usr/bin/env node
// Turn one agent run into a single JSON metrics line, and score the final answer.
//   copilot: session events.jsonl (falls back to --output-format json stdout)
//   claude:  --output-format stream-json stdout
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const opt = {};
for (let i = 2; i < process.argv.length; i += 2) opt[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const agent = opt.agent || 'copilot';

const readJsonl = (file) =>
  file && existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    : [];

// Each reader returns: { calls:[{name,args}], turns, answer, finished, tokens, costUsd, nanoAiu, premiumRequests, apiMs }
function readCopilot() {
  let events = readJsonl(opt.events);
  const fromStdout = readJsonl(opt.stdout);
  if (!events.some((e) => e.type === 'session.shutdown') && fromStdout.length) events = fromStdout;

  const calls = [];
  const messages = [];
  let turns = 0;
  let shutdown = null;
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === 'assistant.turn_start') turns++;
    if (e.type === 'session.shutdown') shutdown = d;
    if (e.type === 'assistant.message' && d.content) messages.push({ text: d.content, hasTools: (d.toolRequests ?? []).length > 0 });
    if (e.type === 'tool.execution_start') calls.push({ name: d.toolName ?? '?', args: d.arguments ?? {} });
  }

  // Copilot's inputTokens already include cache reads.
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const mm = shutdown?.modelMetrics ?? {};
  if (Object.keys(mm).length) {
    for (const m of Object.values(mm)) {
      const u = m.usage ?? {};
      tokens.input += u.inputTokens ?? 0;
      tokens.cacheRead += u.cacheReadTokens ?? 0;
      tokens.cacheWrite += u.cacheWriteTokens ?? 0;
      tokens.output += u.outputTokens ?? 0;
    }
  } else if (shutdown?.tokenDetails) {
    const t = shutdown.tokenDetails;
    tokens.input = t.input?.tokenCount ?? 0;
    tokens.cacheRead = t.cache_read?.tokenCount ?? 0;
    tokens.cacheWrite = t.cache_write?.tokenCount ?? 0;
    tokens.output = t.output?.tokenCount ?? 0;
  }

  // MCP status events are ephemeral: they only appear in the stdout stream.
  const status = fromStdout.filter((e) => e.type === 'session.mcp_server_status_changed' && e.data?.serverName === 'codegraph');
  const mcpAttached = status.length ? status.some((e) => e.data.status === 'connected') : null;

  const finals = messages.filter((m) => !m.hasTools);
  let answer = finals.at(-1)?.text ?? '';
  if (answer.length < 300) answer = messages.map((m) => m.text).join('\n\n');

  return {
    calls, turns, answer, tokens, mcpAttached,
    finished: !!shutdown,
    costUsd: null,
    nanoAiu: shutdown?.totalNanoAiu ?? null,
    premiumRequests: shutdown?.totalPremiumRequests ?? null,
    apiMs: shutdown?.totalApiDurationMs ?? null,
  };
}

function readClaude() {
  const events = readJsonl(opt.stdout);
  const calls = [];
  const texts = [];
  const usageById = new Map(); // stream-json repeats a message per content block; count each id once
  let result = null;
  let mcpAttached = null;
  let permissionMode = null;
  const nameById = new Map();
  const denied = {};
  for (const e of events) {
    if (e.type === 'result') result = e;
    if (e.type === 'system' && e.subtype === 'init') permissionMode = e.permissionMode ?? null;
    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        const text = Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join('') : String(b.content ?? '');
        if (b.type === 'tool_result' && b.is_error && /Permission to use|requested permissions to use/.test(text)) {
          const n = nameById.get(b.tool_use_id) ?? '?';
          denied[n] = (denied[n] ?? 0) + 1;
        }
      }
    }
    if (e.type === 'system' && e.subtype === 'init') {
      const cg = (e.mcp_servers ?? []).find((m) => m.name === 'codegraph');
      mcpAttached = cg ? cg.status === 'connected' || (e.tools ?? []).some((t) => /codegraph/.test(t)) : null;
    }
    if (e.type !== 'assistant' || !e.message) continue;
    const m = e.message;
    if (m.id && m.usage) usageById.set(m.id, m.usage);
    for (const b of m.content ?? []) {
      if (b.type === 'tool_use') { calls.push({ name: b.name, args: b.input ?? {} }); nameById.set(b.id, b.name); }
      // Review findings reported through a tool are part of the answer.
      if (b.type === 'tool_use' && b.name === 'ReportFindings') {
        for (const f of b.input?.findings ?? []) texts.push([f.file, f.summary, f.failure_scenario].filter(Boolean).join(' — '));
      }
      if (b.type === 'text' && b.text && !e.parent_tool_use_id) texts.push(b.text);
    }
  }

  // Normalize to Copilot's convention: input INCLUDES cache reads + cache writes.
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const mu = result?.modelUsage ?? {};
  if (Object.keys(mu).length) {
    for (const u of Object.values(mu)) {
      tokens.cacheRead += u.cacheReadInputTokens ?? 0;
      tokens.cacheWrite += u.cacheCreationInputTokens ?? 0;
      tokens.input += (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
      tokens.output += u.outputTokens ?? 0;
    }
  } else {
    // result.usage is last-turn only, so sum the per-message usage instead.
    for (const u of usageById.values()) {
      tokens.cacheRead += u.cache_read_input_tokens ?? 0;
      tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
      tokens.input += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      tokens.output += u.output_tokens ?? 0;
    }
  }

  let answer = typeof result?.result === 'string' ? result.result : '';
  if (answer.length < 300) answer = [...texts.filter((t) => t !== answer), answer].filter(Boolean).join('\n\n');

  return {
    calls, answer, tokens, mcpAttached, permissionMode, denied,
    turns: result?.num_turns ?? usageById.size,
    finished: result?.subtype === 'success' && !result?.is_error,
    costUsd: result?.total_cost_usd ?? null,
    nanoAiu: null,
    premiumRequests: null,
    apiMs: result?.duration_api_ms ?? null,
  };
}

const run = agent === 'claude' ? readClaude() : readCopilot();

// Classify tool calls with one vocabulary across both agents.
const SEARCH_CMD = /(^|[\s|;&(])(grep|rg|ag|ack|find|fd|git\s+grep)\b/;
const READ_CMD = /(^|[\s|;&(])(cat|head|tail|less|nl|bat)\b|sed\s+-n/;
const READ_TOOLS = /^(view|read|read_file|show_file)$/i;
const SEARCH_TOOLS = /^(rg|grep|glob|search|find|file_search|ls)$/i;
const SHELL_TOOLS = /^(bash|shell|powershell)$/i;
const SUBAGENT_TOOLS = /^(task|agent)$/i;

const tools = { total: 0, codegraph: 0, read: 0, search: 0, bash: 0, bashSearch: 0, bashRead: 0, subagent: 0, other: 0, byName: {} };
const sequence = [];
for (const { name, args } of run.calls) {
  tools.total++;
  tools.byName[name] = (tools.byName[name] ?? 0) + 1;
  if (/codegraph/i.test(name)) {
    tools.codegraph++;
    sequence.push(`${name} ${JSON.stringify(args.query ?? args.symbol ?? '').slice(0, 70)}`);
  } else if (READ_TOOLS.test(name)) {
    tools.read++;
    sequence.push(`${name} ${String(args.path ?? args.file_path ?? '').split('/').slice(-2).join('/')}`);
  } else if (SEARCH_TOOLS.test(name)) {
    tools.search++;
    sequence.push(`${name} ${String(args.pattern ?? args.query ?? args.path ?? '').slice(0, 50)}`);
  } else if (SHELL_TOOLS.test(name)) {
    tools.bash++;
    const cmd = String(args.command ?? '');
    if (SEARCH_CMD.test(cmd)) tools.bashSearch++;
    else if (READ_CMD.test(cmd)) tools.bashRead++;
    sequence.push(`${name} ${cmd.slice(0, 60)}`);
  } else if (SUBAGENT_TOOLS.test(name)) {
    tools.subagent++;
    sequence.push(`${name} ${String(args.subagent_type ?? args.description ?? '').slice(0, 40)}`);
  } else {
    tools.other++;
    sequence.push(name);
  }
}

if (opt['answer-out']) writeFileSync(opt['answer-out'], run.answer);

const scenario = JSON.parse(readFileSync(process.env.SCENARIOS || join(HERE, '..', 'scenarios.json'), 'utf8')).scenarios.find((s) => s.id === opt.id);
const low = run.answer.toLowerCase();
const hit = (group) => group.some((alt) => low.includes(alt.toLowerCase()));
const expectGroups = scenario?.expect ?? [];
const score = {
  expect: expectGroups.length ? +(expectGroups.filter(hit).length / expectGroups.length).toFixed(2) : null,
  missed: expectGroups.filter((g) => !hit(g)).map((g) => g[0]),
  detected: scenario?.detect ? scenario.detect.every(hit) : null,
};

console.log(JSON.stringify({
  agent,
  agentVersion: opt['agent-version'] || null,
  id: opt.id,
  repo: scenario?.repo,
  type: scenario?.type,
  kind: scenario?.kind,
  arm: opt.arm,
  run: Number(opt.run),
  model: opt.model,
  effort: opt.effort,
  codegraphVersion: opt['cg-version'] || null,
  exit: Number(opt.exit),
  completed: run.finished && Number(opt.exit) === 0,
  tampered: opt.tampered === '1',
  mcpAttached: run.mcpAttached,
  permissionMode: run.permissionMode ?? null,
  denied: run.denied ?? {},
  wallMs: Number(opt['wall-ms']),
  apiMs: run.apiMs,
  turns: run.turns,
  tools,
  tokens: run.tokens,
  costUsd: run.costUsd,
  premiumRequests: run.premiumRequests,
  nanoAiu: run.nanoAiu,
  score,
  answerChars: run.answer.length,
  sequence,
  at: new Date().toISOString(),
}));
