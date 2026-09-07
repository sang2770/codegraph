import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import {
  CHARACTERS_PER_TOKEN,
  extractContextFilePaths,
  measureFileReadBaseline,
} from './baseline';
import {
  collectGitCommitReviewContext,
  collectGitReviewContext,
  GitReviewContext,
  listGitCommits,
} from './gitContext';
import { GraphCache } from './graphCache';
import { buildImpactMarkdown } from './impact';
import { ImpactController } from './impactController';
import { IndexFreshness } from './indexFreshness';
import { IndexManager } from './indexManager';
import { readIndexStatus } from './indexStatus';
import {
  detectConversationLanguage,
  detectResponseLanguage,
  responseLanguageInstruction,
} from './language';
import {
  ChatRequestTokenSample,
  MetricsStore,
  savingsPercent,
} from './metrics';
import { ReportManager } from './reportManager';
import { normalizeReport, ReportKind } from './reports';
import { readProjectReadmeContext } from './readmeContext';
import { customReviewPrompt } from './reviewInstructions';
import {
  codeBrainEnvironment,
  runCodeBrain,
  RuntimeCommand,
} from './runtime';
import {
  activeEditorContext,
  getWorkspaceFolder,
  hasIndex,
} from './workspace';

interface CodeBrainChatResult extends vscode.ChatResult {
  metadata: {
    command: ReportKind;
    report?: string;
    tokens?: ChatRequestTokenSample;
  };
}

interface GeneratedReport {
  text: string;
  codeBrainContextTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Extra graph evidence the model pulled in through the explore tool. */
  extraEvidence: string;
  /** How many times the model asked for more evidence. */
  toolRounds: number;
}

const EXPLAIN_INSTRUCTIONS = `You are a senior software architect using a precomputed semantic code graph.
Answer the user's question in the same language as the user.

Your purpose is to help a developer understand the business workflow and then connect each business step to the code that implements it. Start with what happens from a user's or system's point of view, why the workflow exists, and what result it produces. Then show how the code executes that workflow through concrete functions, files, line numbers, data transformations, state changes, side effects, and failure paths. Do not produce a generic symbol inventory and do not propose edits unless needed to clarify behavior.

Translate graph terminology into plain developer language. Do not use the words "caller", "callee", or "calling" in the explanation. Say "entry point", "function that starts this step", "next function", "downstream dependency", "where this function is used", or "next execution step" instead. Keep source identifiers such as a function named \`callingMode\` unchanged when quoting code.

Return a self-contained Markdown report with exactly this high-level structure:
# <specific title>
## Executive summary
## Purpose
## Business workflow
Describe the workflow as numbered business steps. For every step, give the concrete file, symbol, and line that implement it when evidence supports it.
## Code flow illustration
Show a compact, readable pseudo-code or code-like walkthrough that maps the business steps to the concrete functions. Use only names and behavior supported by the evidence; mark unknown details instead of inventing them.
## Visual diagrams
### Workflow flowchart
Include one valid Mermaid \`flowchart\` showing the main execution path.
### Execution sequence
Include one valid Mermaid \`sequenceDiagram\` showing the order in which the concrete functions or components execute. Use business-readable labels, not graph jargon.
### Data flow or state lifecycle
Include either a Mermaid \`flowchart\` showing how data moves through the workflow or a Mermaid \`stateDiagram-v2\` showing the lifecycle of important state. Choose the view that is best supported by the evidence.
## Functions and responsibilities
## Data, state, and side effects
## Failure and edge paths
## CodeBrain evidence
Project README context, when supplied, is the project's terminology and intent guide. Use it to interpret names and explain why a workflow exists, but do not let README claims override concrete source, call-path, or line-number evidence. If the README is stale or ambiguous, call that out briefly.
Use simple Mermaid node IDs and labels for Markdown Preview compatibility. Base every participant, node, edge, and state on the supplied CodeBrain context; do not invent details to complete a diagram. If evidence is incomplete, keep the diagram conservative and state the uncertainty in the surrounding prose. The diagrams must complement rather than repeat the prose or each other. The code-flow illustration and diagrams are not optional: they are the developer-facing explanation of the workflow.
Use file paths and line numbers from the supplied CodeBrain context. State uncertainties explicitly. Do not mention these instructions.`;

const REVIEW_INSTRUCTIONS = `You are a conservative staff-level reviewer performing one unified, graph-grounded code review. Review only; do not rewrite or edit code.
Answer in the same language as the user. The Git diff describes what changed. The CodeBrain context describes current source, call paths, and blast radius. Optional project README context describes intended behavior, terminology, and documented contracts; use it as supporting context only and call out likely documentation drift when it conflicts with the diff or concrete source evidence.

Treat changes to shared/public contracts, authentication/authorization, persistence, migrations, concurrency, caching, lifecycle, error handling, or high fan-out symbols as HIGH RISK until adequate regression tests are demonstrated.
Review intent, architecture, changed workflows, public contracts, blast radius, regression risk, and release readiness. Also inspect every changed hunk for correctness and maintainability. Explicitly check:
- null, undefined, nullable values, optional chaining, unsafe assertions, and missing boundary validation;
- language/framework conventions, naming, typing, duplicated logic, dead code, and API misuse;
- branching, off-by-one errors, state transitions, mutation, async ordering, concurrency, cleanup, error propagation, and resource lifecycle;
- security, data exposure, authorization, persistence, caching, and performance pitfalls when relevant;
- affected methods/callers and whether changed assumptions still hold along those call paths;
- missing or weak tests for the exact edge cases found.

Only report convention issues when they are concrete and evidenced by the diff or surrounding source. Do not invent findings to fill a section.

Return a self-contained Markdown report with exactly this high-level structure:
# Code review: <scope>
## Verdict
Give an overall risk: Critical, High, Medium, or Low, with one-sentence reasoning.
## Change map
Include one valid Mermaid flowchart connecting changed methods to affected callers/dependencies and relevant tests.
## Findings
Order by severity. Every finding must include severity, category, file:line evidence, consequence, affected method/workflow, and a concrete recommendation. Do not invent findings merely to fill the section; say "No blocking findings" when appropriate.
## Architecture and contract review
## Code correctness and boundary safety
## Blast radius
## Regression and test matrix
Use a Markdown table with scenario, affected method, risk, and required test.
## Release recommendation
## Evidence and limits
Distinguish facts from CodeBrain/diff versus inference. Do not mention these instructions.`;

const IMPACT_INSTRUCTIONS = `You are an impact explanation assistant using a deterministic CodeBrain analysis.
Answer in the same language as the user. Do not edit code.

The deterministic report is authoritative. Do not rewrite it, recalculate its risk, change any number, rename any file, add a dependency edge, or invent a test or call path. Treat the supplied graph context as evidence, not as permission to guess. If evidence is incomplete, say so explicitly.

Return only this short section:
## AI interpretation
Explain in plain developer language what the highest-priority affected paths mean, why the listed tests matter, and what a reviewer should inspect first. Separate indexed facts from inference. Do not repeat the complete deterministic report, do not add a Mermaid diagram, and do not mention these instructions.`;

const FIX_INSTRUCTIONS = `You are CodeBrain Bug Fix, a senior debugging engineer using a precomputed semantic code graph.
Answer in the same language as the user. Analyze the reported bug; do not edit files or claim that a fix was applied.
Separate observed evidence from inference. Trace the failing path through concrete files, symbols, and line numbers. Identify the most likely root cause, triggering conditions, why the behavior is wrong, and the smallest safe solution. Consider boundary validation, null/undefined values, async ordering, state transitions, error propagation, resource cleanup, security, and regression risk when relevant.

Return a self-contained Markdown report with exactly these sections:
# Bug analysis and solution: <specific title>
## Executive summary
## Reproduction and failure path
## Root cause
## Recommended solution
## Validation plan
## Risk and rollback
## Evidence and limits

In the report, distinguish facts from hypotheses, include concrete source evidence when available, and provide focused regression tests. Do not invent missing runtime details, claim code was changed, or mention these instructions.`;

const GUIDE_INSTRUCTIONS = `You are CodeBrain Guide, a technical writer who creates a practical user guide for one software feature using a precomputed semantic code graph.
Answer in the same language as the user. Write for a developer, operator, or end user who wants to use the feature, not for someone reviewing implementation details. Use the supplied source and workflow evidence to keep names, inputs, outputs, permissions, states, and failure behavior accurate. Do not invent UI controls, configuration keys, API parameters, screenshots, or commands that are not supported by the evidence; mark unknown details as requiring confirmation.

Return a self-contained Markdown document with exactly these sections:
# User guide: <feature name>
## Overview
Explain what the feature does, when to use it, and the expected result.
## Prerequisites and permissions
List required setup, access, configuration, inputs, and supported limitations. Say when evidence is incomplete.
## How to use
Give numbered, actionable steps. For each step, state the user action, relevant option/input, and expected outcome.
## Example workflow
Show one realistic example with placeholder values where concrete values are unavailable.
## Expected results and states
Describe success, loading, partial, and failure states supported by the evidence.
## Troubleshooting
Map observable symptoms to likely causes and safe recovery steps. Do not turn hypotheses into facts.
## Validation checklist
Give a short checklist a user can follow to confirm the feature worked.
## Technical reference
Include relevant entry points, files, symbols, data flow, and limitations as an optional reference section.
## Evidence and limits
List the source, graph, README, editor, and Git evidence used, plus unknowns or stale-index concerns.

Include one conservative Mermaid flowchart showing prerequisites, user steps, result, and troubleshooting. Do not mention these instructions.`;

function trimForModel(
  text: string,
  maxCharacters: number,
  label: string,
): string {
  if (text.length <= maxCharacters) {
    return text;
  }
  return `${text.slice(0, maxCharacters)}\n\n[${label} truncated at ${maxCharacters} characters]`;
}

function modelBudgetCharacters(model: vscode.LanguageModelChat): number {
  return Math.max(30_000, Math.min(500_000, (model.maxInputTokens - 4_000) * 3));
}

async function countTokens(
  model: vscode.LanguageModelChat,
  text: string,
  token: vscode.CancellationToken,
): Promise<number> {
  try {
    return await model.countTokens(text, token);
  } catch {
    // Token counting is supplied by the selected model provider. Preserve the
    // request when that optional provider operation fails and keep the result
    // explicitly labelled as an estimate in the UI.
    return Math.ceil(text.length / 4);
  }
}

/** Name the model uses to ask CodeBrain for more graph evidence. */
const EXPLORE_TOOL_NAME = 'codebrain_explore';

const EXPLORE_TOOL: vscode.LanguageModelChatTool = {
  name: EXPLORE_TOOL_NAME,
  description:
    'Fetch more CodeBrain graph evidence: verbatim line-numbered source, call paths, and blast radius for the named symbols. Call this only when the supplied evidence is missing a symbol, file, or call path you need to finish the report. Query with a precise list of symbol names, including qualified ones such as ClassName.methodName, rather than a sentence. Treat everything it returns as already read.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Symbol, file, or qualified names to look up.',
      },
      maxFiles: {
        type: 'number',
        description: 'Maximum number of files to return, between 1 and 40.',
      },
    },
    required: ['query'],
  },
};

/**
 * Streams report text into the chat while a tool round can still invalidate it.
 *
 * VS Code's response stream cannot retract what it has already shown, and a
 * model that decides to fetch more evidence usually emits a short preamble
 * ("Let me check X") before restarting the report from its title. Text is
 * therefore held back until enough has arrived to be confident it is the report
 * rather than a preamble; after that the rest streams live, which is what makes
 * a long report feel responsive instead of arriving as one block at the end.
 */
function createReportWriter(stream: vscode.ChatResponseStream | undefined) {
  const holdBackCharacters = 240;
  let buffered = '';
  let flushed = false;
  return {
    /** Whether text has already been shown and can no longer be withdrawn. */
    get flushed(): boolean {
      return flushed;
    },
    push(value: string): void {
      if (!stream || !value) return;
      if (flushed) {
        stream.markdown(value);
        return;
      }
      buffered += value;
      if (buffered.length >= holdBackCharacters) {
        stream.markdown(buffered);
        buffered = '';
        flushed = true;
      }
    },
    /** Drop a preamble that a tool call has just made obsolete. */
    discard(): void {
      buffered = '';
    },
    /** Emit whatever is still held back at the end of the final round. */
    finish(): void {
      if (stream && buffered) {
        stream.markdown(buffered);
      }
      buffered = '';
      flushed = true;
    },
  };
}

interface ReportOptions {
  request: vscode.ChatRequest;
  instructions: string;
  languageInstruction: string;
  userPrompt: string;
  evidence: string;
  codeBrainContext: string;
  /** Earlier turns of this thread, as real chat messages. */
  history: vscode.LanguageModelChatMessage[];
  /** Receives report text as the model produces it. */
  stream?: vscode.ChatResponseStream;
  /** Fetches more graph evidence when the model asks for it. */
  expand?: (query: string, maxFiles: number) => Promise<string>;
  /** Upper bound on evidence round-trips before the report must be written. */
  maxToolRounds?: number;
  /** Default file budget for a tool-requested lookup. */
  defaultMaxFiles: number;
  /** Reports what the model is doing between rounds. */
  progress?: (message: string) => void;
}

async function generateReport(
  options: ReportOptions,
  token: vscode.CancellationToken,
): Promise<GeneratedReport> {
  const { request, instructions, userPrompt } = options;
  const budget = modelBudgetCharacters(request.model);
  const evidenceBudget = Math.max(10_000, budget - instructions.length - userPrompt.length);
  const instructionText = `${instructions}\n\n${options.languageInstruction}`;
  const requestText = `User request:\n${userPrompt}\n\nEvidence:\n${trimForModel(
    options.evidence,
    evidenceBudget,
    'evidence',
  )}`;
  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(instructionText),
    ...options.history,
    vscode.LanguageModelChatMessage.User(requestText),
  ];
  const [inputTokens, codeBrainContextTokens] = await Promise.all([
    countTokens(request.model, `${instructionText}\n\n${requestText}`, token),
    countTokens(request.model, options.codeBrainContext, token),
  ]);

  const maxToolRounds = options.maxToolRounds ?? 0;
  const toolsAvailable = options.expand !== undefined && maxToolRounds > 0;
  const requestOptions: vscode.LanguageModelChatRequestOptions = {
    justification:
      'Generate a local CodeBrain workflow explanation or code review requested by the user.',
    ...(toolsAvailable
      ? {
          tools: [EXPLORE_TOOL],
          toolMode: vscode.LanguageModelChatToolMode.Auto,
        }
      : {}),
  };

  const writer = createReportWriter(options.stream);
  let text = '';
  let extraEvidence = '';
  let toolRounds = 0;

  for (;;) {
    // Tools are withdrawn for the final round, so the model cannot spend it on
    // another lookup and leave no report behind. They are also withdrawn once
    // text is on screen: it cannot be taken back, and a further round would
    // restart a report the user is already reading.
    const toolsThisRound =
      toolsAvailable && !writer.flushed && toolRounds < maxToolRounds;
    const roundOptions: vscode.LanguageModelChatRequestOptions = toolsThisRound
      ? requestOptions
      : { justification: requestOptions.justification };
    const response = await request.model.sendRequest(messages, roundOptions, token);
    const calls: vscode.LanguageModelToolCallPart[] = [];
    let roundText = '';
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        roundText += part.value;
        writer.push(part.value);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        calls.push(part);
      }
    }

    const expand = options.expand;
    if (calls.length === 0 || !expand || toolRounds >= maxToolRounds) {
      text = roundText;
      writer.finish();
      break;
    }

    // The model wants more evidence. Anything it wrote first was a preamble to
    // that decision, not the report, so it never reaches the user.
    writer.discard();
    if (writer.flushed) {
      // Rare: the model wrote past the hold-back window and only then asked for
      // more evidence. The shown text cannot be withdrawn, so mark the seam
      // rather than letting the restarted report look like a duplication bug.
      options.stream?.markdown('\n\n---\n\n');
    }
    toolRounds += 1;
    options.progress?.(
      `Fetching more CodeBrain evidence (round ${toolRounds} of ${maxToolRounds})…`,
    );

    const assistantParts: Array<
      vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
    > = roundText.trim()
      ? [new vscode.LanguageModelTextPart(roundText), ...calls]
      : [...calls];
    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

    const resultParts: vscode.LanguageModelToolResultPart[] = [];
    for (const call of calls) {
      const input = call.input as { query?: unknown; maxFiles?: unknown };
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      let resultText: string;
      if (call.name !== EXPLORE_TOOL_NAME || !query) {
        resultText = `Unsupported tool call. Only ${EXPLORE_TOOL_NAME} with a non-empty "query" is available.`;
      } else {
        const maxFiles =
          typeof input.maxFiles === 'number' && Number.isFinite(input.maxFiles)
            ? Math.max(1, Math.min(40, Math.round(input.maxFiles)))
            : options.defaultMaxFiles;
        try {
          resultText = await expand(query, maxFiles);
          extraEvidence += `\n\n${resultText}`;
        } catch (error) {
          // A failed lookup is a recoverable condition: tell the model so it
          // finishes the report from what it already has, instead of failing
          // the whole request over optional extra evidence.
          resultText = `CodeBrain could not answer that lookup: ${
            error instanceof Error ? error.message : String(error)
          }. Write the report from the evidence you already have and state the gap.`;
        }
      }
      resultParts.push(
        new vscode.LanguageModelToolResultPart(call.callId, [
          new vscode.LanguageModelTextPart(resultText),
        ]),
      );
    }
    messages.push(vscode.LanguageModelChatMessage.User(resultParts));

    if (toolRounds >= maxToolRounds) {
      messages.push(
        vscode.LanguageModelChatMessage.User(
          'No further lookups are available. Write the complete report now from the evidence gathered so far, and state any remaining gap under Evidence and limits.',
        ),
      );
    }
  }

  const outputTokens = await countTokens(request.model, text, token);
  return {
    text,
    codeBrainContextTokens,
    inputTokens,
    outputTokens,
    extraEvidence,
    toolRounds,
  };
}

/**
 * Footer reporting what the graph context cost versus what reading the same
 * files would have cost.
 *
 * Both sides of the comparison are derived the same way — real byte counts at
 * the same bytes-per-token ratio — so the ratio between them means something.
 * The previous version multiplied the context size by a hard-coded 6.5, which
 * made the reported saving a fixed ~85% no matter what the repository or the
 * question was.
 */
export function tokenUsageFooter(
  sample: ChatRequestTokenSample,
  languageCode: string,
  comparison: { contextCharacters: number },
): string {
  const locale = languageCode === 'vi' ? 'vi-VN' : 'en-US';
  const format = (value: number) => new Intl.NumberFormat(locale).format(value);
  const vi = languageCode === 'vi';
  const requestLine = vi
    ? `> * ⏱️ **Request:** input **${format(sample.inputTokens)}** + output **${format(sample.outputTokens)}** tokens (do ${sample.model} đếm) · **${format(sample.latencyMs)} ms**`
    : `> * ⏱️ **Request:** input **${format(sample.inputTokens)}** + output **${format(sample.outputTokens)}** tokens (counted by ${sample.model}) · **${format(sample.latencyMs)} ms**`;

  if (!sample.baselineMeasured) {
    return [
      '---',
      vi ? '> 📊 **Chi phí context CodeBrain**' : '> 📊 **CodeBrain context cost**',
      requestLine,
      vi
        ? '> * ℹ️ Không có tệp ứng viên nào để đo, nên phần tiết kiệm là **không xác định**.'
        : '> * ℹ️ No candidate file was available to measure, so savings are **unknown**.',
    ].join('\n');
  }

  // Compare like with like: the model's tokenizer and a byte-ratio estimate are
  // not the same unit, so the ratio uses the byte ratio on both sides.
  const contextTokens = Math.ceil(comparison.contextCharacters / CHARACTERS_PER_TOKEN);
  const percent = savingsPercent({
    baselineMeasured: true,
    baselineTokens: sample.baselineTokens,
    contextTokens,
  });
  const saved = Math.max(0, sample.baselineTokens - contextTokens);

  if (vi) {
    return [
      '---',
      '> 📊 **Chi phí context CodeBrain (đo thật)**',
      `> * 🟢 **Context đồ thị trả về:** **${format(contextTokens)}** tokens`,
      `> * 🔴 **Đọc đầy đủ ${format(sample.baselineFiles)} tệp đó:** **${format(sample.baselineTokens)}** tokens`,
      `> * ⚡ **Chênh lệch:** **${format(saved)}** tokens${percent !== undefined ? ` (~${percent}%)` : ''}`,
      requestLine,
      '>',
      '> Baseline đo từ kích thước thật trên đĩa của các tệp CodeBrain lấy bằng chứng; cả hai phía dùng cùng tỉ lệ 4 byte ≈ 1 token. Không phải dữ liệu billing.',
    ].join('\n');
  }
  return [
    '---',
    '> 📊 **CodeBrain context cost (measured)**',
    `> * 🟢 **Graph context returned:** **${format(contextTokens)}** tokens`,
    `> * 🔴 **Reading those ${format(sample.baselineFiles)} files in full:** **${format(sample.baselineTokens)}** tokens`,
    `> * ⚡ **Difference:** **${format(saved)}** tokens${percent !== undefined ? ` (~${percent}%)` : ''}`,
    requestLine,
    '>',
    '> The baseline is measured from the real on-disk size of the files CodeBrain drew evidence from; both sides use the same 4 bytes ≈ 1 token ratio. Not billing data.',
  ].join('\n');
}

/**
 * Recent turns of this chat thread as real chat messages, so a follow-up like
 * “what about the other one?” has something to refer to.
 *
 * These used to be pasted into the evidence string as an abbreviated
 * transcript, which spent evidence budget and hid the turn structure. As proper
 * User/Assistant messages the model resolves references the way it resolves any
 * conversation. Assistant turns are still truncated hard: CodeBrain reports are
 * long, and the useful part for continuity is which subject was discussed, not
 * the whole document.
 */
export function historyMessages(
  history: readonly unknown[],
  maxTurns = 4,
  maxResponseCharacters = 1_500,
): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = [];
  for (const turn of history.slice(-maxTurns)) {
    if (turn instanceof vscode.ChatRequestTurn) {
      const command = turn.command ? `/${turn.command} ` : '';
      const prompt = `${command}${turn.prompt.trim()}`.slice(0, 1_000);
      if (prompt) {
        messages.push(vscode.LanguageModelChatMessage.User(prompt));
      }
      continue;
    }
    if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .filter(
          (part): part is vscode.ChatResponseMarkdownPart =>
            part instanceof vscode.ChatResponseMarkdownPart,
        )
        .map((part) => part.value.value)
        .join('\n')
        .replace(/```mermaid[\s\S]*?```/g, '[diagram]')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) {
        messages.push(
          vscode.LanguageModelChatMessage.Assistant(
            `(previous CodeBrain report, abbreviated) ${text.slice(0, maxResponseCharacters)}`,
          ),
        );
      }
    }
  }
  return messages;
}

/** User prompts from this thread, oldest first, including the current one. */
export function historyPrompts(
  history: readonly unknown[],
  currentPrompt: string,
): string[] {
  const prompts = history
    .filter((turn): turn is vscode.ChatRequestTurn => turn instanceof vscode.ChatRequestTurn)
    .map((turn) => turn.prompt);
  return [...prompts, currentPrompt];
}


function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-phrase match that also works for non-ASCII triggers.
 *
 * `\b` is defined over ASCII word characters only, so a phrase beginning or
 * ending with a Vietnamese letter — `ảnh hưởng`, `đánh giá` — could never
 * satisfy a `\b` boundary next to a space, and those triggers silently never
 * fired. Unicode property escapes make the boundary mean what it reads as.
 */
export function matchesTrigger(
  prompt: string,
  terms: readonly string[],
): boolean {
  return terms.some((term) =>
    new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`,
      'iu',
    ).test(prompt),
  );
}

const FIX_TRIGGERS = [
  'fix',
  'bug',
  'debug',
  'root cause',
  'cause',
  'solution',
  'lỗi',
  'nguyên nhân',
  'giải pháp',
  'sửa lỗi',
];

const IMPACT_TRIGGERS = [
  'impact',
  // Bare "affected", so "which tests are affected" reaches /impact the same way
  // "affected tests" does. Word order varies; the word itself does not.
  'affected',
  'change impact',
  'ảnh hưởng',
  'tác động',
];

const REVIEW_TRIGGERS = [
  'review',
  'diff',
  'risk',
  'regression',
  'blast radius',
  'rủi ro',
  'đánh giá',
  'kiểm tra code',
];

const GUIDE_TRIGGERS = [
  'user guide',
  'how to use',
  'documentation',
  'hướng dẫn',
  'tài liệu',
  'tài liệu sử dụng',
];

export function inferCommand(request: {
  command: string | undefined;
  prompt: string;
}): ReportKind {
  const explicit = request.command;
  if (
    explicit === 'impact' ||
    explicit === 'review' ||
    explicit === 'explain' ||
    explicit === 'fix' ||
    explicit === 'guide'
  ) {
    return explicit;
  }
  if (matchesTrigger(request.prompt, FIX_TRIGGERS)) {
    return 'fix';
  }
  if (matchesTrigger(request.prompt, IMPACT_TRIGGERS)) {
    return 'impact';
  }
  if (matchesTrigger(request.prompt, GUIDE_TRIGGERS)) {
    return 'guide';
  }
  return matchesTrigger(request.prompt, REVIEW_TRIGGERS) ? 'review' : 'explain';
}

function buildExplainQuery(prompt: string, editorContext: string): string {
  const focus = [prompt, editorContext.split('\n').slice(0, 3).join(' ')]
    .filter(Boolean)
    .join(' ');
  return `Explain the business workflow and developer-readable execution flow for: ${focus}. Identify the entry point or trigger, the ordered business steps, decisions and validations, data transformations, state changes, side effects, result, and failure paths. Return concrete symbols, files, line numbers, and short source snippets where available. Avoid a generic symbol inventory and avoid caller/callee terminology.`.slice(
    0,
    6_000,
  );
}

function buildReviewQuery(
  prompt: string,
  gitContext: GitReviewContext,
  editorContext: string,
): string {
  const files = gitContext.changedFiles.slice(0, 80).join(' ');
  const focus = [prompt, files, editorContext.split('\n').slice(0, 3).join(' ')]
    .filter(Boolean)
    .join(' ');
  const goal =
    'Perform one unified code review. Trace changed workflows, public contracts, affected methods, callers and dependencies; inspect every changed hunk for correctness, null/undefined boundaries, error paths, async/state behavior, concrete convention issues, blast radius, regression risk, missing edge-case tests, and release readiness for';
  return `${goal}: ${focus}`.slice(
    0,
    6_000,
  );
}

function buildFixQuery(prompt: string, editorContext: string): string {
  const focus = [prompt, editorContext.split('\n').slice(0, 8).join(' ')]
    .filter(Boolean)
    .join(' ');
  return `Analyze this reported bug and trace the failure path through the semantic code graph: ${focus}. Identify the symptom, trigger, expected versus actual behavior, root cause, broken assumption, relevant symbols and line numbers, affected workflows and tests, smallest safe solution, alternatives, and regression validation plan. Separate evidence from hypotheses; do not invent missing runtime details.`.slice(
    0,
    6_000,
  );
}

function buildGuideQuery(prompt: string, editorContext: string): string {
  const focus = [prompt, editorContext.split('\n').slice(0, 8).join(' ')]
    .filter(Boolean)
    .join(' ');
  return `Create a user-facing guide for this feature: ${focus}. Trace the complete supported workflow from entry point to result. Identify prerequisites, permissions, configuration, inputs, user-visible states, success and failure outcomes, recovery paths, examples, validation checks, relevant tests, and implementation reference points. Prefer concrete evidence and explicitly mark unknown user-facing details.`.slice(
    0,
    6_000,
  );
}

/** How much of one attachment reaches the model. */
const MAX_REFERENCE_CHARACTERS = 8_000;
const MAX_REFERENCES = 8;
/**
 * Attachments above this size are named but not read.
 *
 * Only the first few thousand characters would survive the budget anyway, and
 * reading is synchronous — a `#file` pointing at a minified bundle or a large
 * fixture would otherwise stall the extension host for the whole read.
 */
const MAX_REFERENCE_FILE_BYTES = 2_000_000;

const FENCE_LANGUAGES: Record<string, string> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.cjs': 'js',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.sql': 'sql',
  '.md': 'markdown',
};

/**
 * A reference's file path, whether it arrived as a `Uri` or a `Location`.
 *
 * Detection is by shape rather than `instanceof`: chat references cross an
 * extension-host boundary, and the concrete classes a host hands over are not
 * guaranteed to be the ones this module imported.
 */
function referenceFsPath(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const location = (value as { uri?: { fsPath?: unknown } }).uri;
  if (location && typeof location.fsPath === 'string') {
    return location.fsPath;
  }
  const uri = (value as { fsPath?: unknown }).fsPath;
  return typeof uri === 'string' ? uri : undefined;
}

/** Zero-based line span of a `Location`-shaped reference. */
function referenceLines(
  value: unknown,
): { start: number; end: number } | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const range = (value as {
    range?: { start?: { line?: unknown }; end?: { line?: unknown } };
  }).range;
  const start = range?.start?.line;
  const end = range?.end?.line;
  if (typeof start !== 'number' || typeof end !== 'number') {
    return undefined;
  }
  return { start, end };
}

export interface PromptReference {
  readonly id: string;
  readonly value: unknown;
  readonly modelDescription?: string;
}

export interface ReferenceEvidence {
  /** Markdown block describing everything the user attached, or ''. */
  evidence: string;
  /** File and symbol names worth adding to the graph query. */
  hints: string[];
}

/**
 * Context the user attached to the prompt with `#file`, `#selection`, and
 * friends.
 *
 * Without this the participant answered from the active editor alone, so an
 * explicitly attached file was silently ignored — the opposite of what
 * attaching it means.
 */
export function collectPromptReferences(
  references: readonly PromptReference[],
  folderPath: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
  maxReferences = MAX_REFERENCES,
  maxCharacters = MAX_REFERENCE_CHARACTERS,
): ReferenceEvidence {
  const blocks: string[] = [];
  const hints: string[] = [];
  const root = folderPath.replace(/[\\/]$/, '');

  for (const reference of references.slice(0, maxReferences)) {
    const filePath = referenceFsPath(reference.value);
    if (filePath) {
      const relativePath = relative(root, filePath).replaceAll('\\', '/');
      // An attachment from outside the project cannot be matched against the
      // graph and may be anywhere on disk, so it is named but not read.
      if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath.startsWith('../')) {
        blocks.push(`### ${basename(filePath)} (outside the project; not read)`);
        continue;
      }
      const lines = referenceLines(reference.value);
      let body: string;
      try {
        const bytes = statSync(filePath).size;
        if (bytes > MAX_REFERENCE_FILE_BYTES) {
          blocks.push(
            `### ${relativePath} (${Math.round(bytes / 1_000_000)} MB; too large to inline, ask CodeBrain about its symbols instead)`,
          );
          hints.push(relativePath, basename(filePath, extname(filePath)));
          continue;
        }
        const text = readFile(filePath);
        body = lines
          ? text
              .split(/\r?\n/)
              .slice(lines.start, lines.end + 1)
              .join('\n')
          : text;
      } catch {
        blocks.push(`### ${relativePath} (could not be read)`);
        continue;
      }
      const label = lines
        ? `${relativePath}:${lines.start + 1}-${lines.end + 1}`
        : relativePath;
      const fence = FENCE_LANGUAGES[extname(filePath).toLowerCase()] ?? '';
      blocks.push(
        `### ${label}\n\`\`\`${fence}\n${trimForModel(body, maxCharacters, 'attachment')}\n\`\`\``,
      );
      hints.push(relativePath, basename(filePath, extname(filePath)));
      continue;
    }

    if (typeof reference.value === 'string' && reference.value.trim()) {
      blocks.push(
        `### ${reference.id}\n${trimForModel(reference.value.trim(), maxCharacters, 'attachment')}`,
      );
      hints.push(reference.value.trim().slice(0, 80));
      continue;
    }

    if (reference.modelDescription?.trim()) {
      blocks.push(`### ${reference.id}\n${reference.modelDescription.trim()}`);
    }
  }

  if (blocks.length === 0) {
    return { evidence: '', hints: [] };
  }
  return {
    evidence: [
      '## Context the user attached to the prompt',
      'Treat these attachments as deliberately chosen focus. They are already read; do not ask for them again.',
      ...blocks,
    ].join('\n\n'),
    hints: [...new Set(hints)].filter(Boolean),
  };
}

export interface CodeReference {
  path: string;
  line: number;
}

/**
 * `path:line` citations in a finished report, so the chat can offer them as
 * clickable locations instead of text the user has to retype.
 */
export function extractCodeReferences(
  report: string,
  limit = 15,
): CodeReference[] {
  const pattern =
    /(?:^|[\s*_(`[<])((?:[\w@.-]+[/\\])+[\w@.+-]+\.[A-Za-z0-9]+):(\d+)/gm;
  const found: CodeReference[] = [];
  const seen = new Set<string>();
  for (const match of report.matchAll(pattern)) {
    const path = match[1]?.replaceAll('\\', '/');
    const line = Number.parseInt(match[2] ?? '', 10);
    if (!path || path.startsWith('http') || !Number.isFinite(line) || line < 1) {
      continue;
    }
    const key = `${path}:${line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    found.push({ path, line });
    if (found.length >= limit) {
      break;
    }
  }
  return found;
}

/** Relative paths as the nested shape `ChatResponseStream.filetree` expects. */
export function buildFileTree(
  paths: readonly string[],
): vscode.ChatResponseFileTree[] {
  const roots: vscode.ChatResponseFileTree[] = [];
  for (const path of paths) {
    const segments = path.replaceAll('\\', '/').split('/').filter(Boolean);
    let level = roots;
    for (const [index, segment] of segments.entries()) {
      const isFile = index === segments.length - 1;
      let node = level.find((entry) => entry.name === segment);
      if (!node) {
        node = isFile ? { name: segment } : { name: segment, children: [] };
        level.push(node);
      }
      if (isFile) {
        break;
      }
      node.children ??= [];
      level = node.children;
    }
  }
  return roots;
}

/**
 * How many files one graph lookup should return for a repository this size.
 *
 * A single fixed budget under-serves a monorepo and over-serves a small
 * package: too little evidence and the model fills the gap with guesses, too
 * much and the report is slower for no gain.
 */
export function scaleContextFiles(indexedFiles: number): number {
  if (!Number.isFinite(indexedFiles) || indexedFiles <= 0) {
    return 12;
  }
  if (indexedFiles < 500) {
    return 10;
  }
  if (indexedFiles < 5_000) {
    return 16;
  }
  if (indexedFiles < 15_000) {
    return 22;
  }
  return 28;
}

/** Indexed file counts, keyed by root and invalidated with the index. */
const indexedFileCounts = new Map<string, { generation: number; count: number }>();

/**
 * File budget for one graph lookup: an explicit setting when the user has one,
 * otherwise a budget scaled to the repository.
 *
 * The count comes from the index rather than the file system, and is cached
 * against the freshness generation so it costs one status call per change
 * rather than one per question.
 */
async function resolveMaxContextFiles(
  config: vscode.WorkspaceConfiguration,
  runtime: RuntimeCommand,
  folder: vscode.WorkspaceFolder,
  freshness: IndexFreshness,
  token: vscode.CancellationToken,
): Promise<number> {
  const inspected = config.inspect<number>('chat.maxContextFiles');
  const explicit =
    inspected?.workspaceFolderValue ??
    inspected?.workspaceValue ??
    inspected?.globalValue;
  if (typeof explicit === 'number' && explicit > 0) {
    return explicit;
  }

  const root = folder.uri.fsPath;
  const generation = freshness.generation(root);
  const cached = indexedFileCounts.get(root);
  if (cached?.generation === generation) {
    return scaleContextFiles(cached.count);
  }
  try {
    const status = await readIndexStatus(runtime, root, token);
    const count = status?.fileCount ?? 0;
    indexedFileCounts.set(root, { generation, count });
    return scaleContextFiles(count);
  } catch {
    // Sizing is an optimization. A failed status call must not fail the report.
    return scaleContextFiles(cached?.count ?? 0);
  }
}

/**
 * Offer the report's `path:line` citations as clickable locations.
 *
 * The report names them either way, but as plain text the user has to retype a
 * path to get there. Only paths that exist on disk are offered, so a citation
 * the model invented does not become a dead link.
 */
function streamCodeAnchors(
  stream: vscode.ChatResponseStream,
  folder: vscode.WorkspaceFolder,
  report: string,
  languageCode: string,
): void {
  const anchors = extractCodeReferences(report).filter((reference) =>
    existsSync(join(folder.uri.fsPath, reference.path)),
  );
  if (anchors.length === 0) {
    return;
  }
  stream.markdown(
    languageCode === 'vi' ? '\n\n**Đi tới code:**\n\n' : '\n\n**Jump to code:**\n\n',
  );
  for (const anchor of anchors) {
    stream.anchor(
      new vscode.Location(
        vscode.Uri.file(join(folder.uri.fsPath, anchor.path)),
        new vscode.Position(anchor.line - 1, 0),
      ),
      `${anchor.path}:${anchor.line}`,
    );
    stream.markdown('\n\n');
  }
}

/** Whether the user asked about commits rather than the working tree. */
export function mentionsCommitHistory(prompt: string): boolean {
  return matchesTrigger(prompt, [
    'commit',
    'commits',
    'changeset',
    'sha',
    'history',
    'lịch sử',
    'lần commit',
  ]);
}

interface ExploreDeps {
  runtime: RuntimeCommand;
  freshness: IndexFreshness;
  cache: GraphCache<string>;
  log: (message: string) => void;
}

async function explore(
  deps: ExploreDeps,
  folder: vscode.WorkspaceFolder,
  query: string,
  maxFiles: number,
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
): Promise<string> {
  const { runtime, freshness, cache, log } = deps;
  const root = folder.uri.fsPath;
  // Refresh only when the workspace changed since the last one, instead of
  // paying a full sync on every question.
  await freshness.ensureFresh(folder, token);

  const generation = freshness.generation(root);
  // The MCP path truncates output to a budget derived from the model's context
  // window, so a result fetched for a small-context model must not be reused
  // for a larger one.
  const cacheKey = {
    root,
    kind: 'explore:chat',
    parts: [query, maxFiles, request.model.id, request.model.maxInputTokens],
  };
  const cached = cache.get(cacheKey, generation);
  if (cached !== undefined) {
    log(`[explore] served from cache (generation ${generation}).`);
    return cached;
  }

  const mcpTool = vscode.lm.tools.find(
    (tool) =>
      /(^|[._/-])codegraph_explore$/i.test(tool.name) ||
      (/(codebrain|codegraph)/i.test(tool.name) &&
        /call paths|blast radius|knowledge graph/i.test(tool.description)),
  );

  if (mcpTool) {
    try {
      const toolResult = await vscode.lm.invokeTool(
        mcpTool.name,
        {
          input: {
            query,
            projectPath: root,
            maxFiles,
          },
          toolInvocationToken: request.toolInvocationToken,
          tokenizationOptions: {
            tokenBudget: Math.max(
              4_000,
              Math.min(32_000, Math.floor(request.model.maxInputTokens * 0.6)),
            ),
            countTokens: (text, countToken) =>
              request.model.countTokens(text, countToken),
          },
        },
        token,
      );
      const text = toolResult.content
        .filter(
          (part): part is vscode.LanguageModelTextPart =>
            part instanceof vscode.LanguageModelTextPart,
        )
        .map((part) => part.value)
        .join('\n');
      if (text.trim()) {
        cache.set(cacheKey, generation, text);
        return text;
      }
      log('[explore] MCP tool returned no text; falling back to the bundled CLI.');
    } catch (error) {
      // MCP discovery/activation is best-effort: the bundled CLI below is the
      // same engine, so reports still work. But swallowing this silently means
      // a permanently broken MCP connection looks like "CodeBrain is just slow"
      // forever, so it is always recorded.
      log(
        `[explore] MCP tool ${mcpTool.name} failed, falling back to the bundled CLI: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } else {
    log('[explore] no CodeBrain MCP tool is registered; using the bundled CLI.');
  }

  const result = await runCodeBrain(
    runtime,
    [
      'explore',
      query,
      '--path',
      root,
      '--max-files',
      String(maxFiles),
    ],
    {
      cwd: root,
      env: codeBrainEnvironment(),
      token,
    },
  );

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'CodeBrain explore failed.');
  }
  cache.set(cacheKey, generation, result.stdout);
  return result.stdout;
}

function reviewEvidence(
  graphContext: string,
  gitContext: GitReviewContext,
  editorContext: string,
  maxDiffCharacters: number,
  readmeContext: string,
  attachments: string,
): string {
  return [
    gitContext.target
      ? `## Review target\nCommit ${gitContext.target.hash} — ${gitContext.target.subject}`
      : '## Review target\nCurrent workspace changes compared with HEAD.',
    '## Git status',
    gitContext.status,
    '## Diff stat',
    gitContext.stat || 'No diff stat available.',
    '## Git diff',
    trimForModel(
      gitContext.diff || 'No tracked diff. Review the selected/current code and untracked file list.',
      maxDiffCharacters,
      'Git diff',
    ),
    gitContext.truncated
      ? 'Warning: Git context was truncated; lower confidence and call this out in Evidence and limits.'
      : '',
    '## Editor focus',
    editorContext || 'No active editor selection.',
    attachments,
    readmeContext ||
      '## Project README context\nNo README.md was found in the project or near the active file.',
    '## CodeBrain source, call paths, and blast radius',
    graphContext,
  ]
    .filter(Boolean)
    .join('\n\n');
}

interface ReviewTargetChoice {
  /** Commit to review, or undefined for the current working tree. */
  commit?: string;
  /** True when the user dismissed the picker without choosing. */
  cancelled: boolean;
}

async function selectReviewCommit(
  root: string,
  prompt: string,
): Promise<ReviewTargetChoice> {
  const explicit = prompt.match(
    /(?:commit|changeset|sha)\s+([0-9a-f]{7,40})\b/i,
  )?.[1] ?? prompt.match(/^\s*([0-9a-f]{7,40})\s*$/i)?.[1];
  if (explicit) return { commit: explicit, cancelled: false };

  // Only interrupt with a picker when the user actually asked about commits.
  // A modal in the middle of a chat request is easy to miss and blocks the
  // answer; the ordinary "review my changes" case has an obvious target.
  if (!mentionsCommitHistory(prompt)) {
    return { cancelled: false };
  }

  const commits = await listGitCommits(root);
  const items: vscode.QuickPickItem[] = [
    {
      label: '$(git-compare) Current workspace changes',
      description: 'Review staged, unstaged, and untracked changes',
      detail: 'No commit selected',
    },
    ...commits.map((commit) => ({
      label: `$(git-commit) ${commit.shortHash} ${commit.subject}`,
      description: commit.hash,
      detail: 'Review this committed change against its first parent',
    })),
  ];
  const selected = await vscode.window.showQuickPick(items, {
    title: 'CodeBrain Review: Choose changes to review',
    placeHolder: 'Select current changes or a commit',
    ignoreFocusOut: true,
  });
  // Escaping the picker is a decision to stop, not a request to review the
  // whole working tree.
  if (!selected) return { cancelled: true };
  if (selected === items[0]) return { cancelled: false };
  return { commit: selected.description || undefined, cancelled: false };
}

function explainEvidence(
  graphContext: string,
  editorContext: string,
  readmeContext: string,
  attachments: string,
): string {
  return [
    '## Editor focus',
    editorContext || 'No active editor selection.',
    attachments,
    readmeContext ||
      '## Project README context\nNo README.md was found in the project or near the active file.',
    '## CodeBrain source and workflow evidence',
    graphContext,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function fixEvidence(
  graphContext: string,
  editorContext: string,
  readmeContext: string,
  gitContext: GitReviewContext,
  maxDiffCharacters: number,
  attachments: string,
): string {
  return [
    '## Reported bug and editor focus',
    editorContext || 'No active editor selection or runtime error was supplied.',
    attachments,
    '## Git status and recent changes',
    gitContext.status,
    gitContext.stat || 'No diff stat available.',
    trimForModel(
      gitContext.diff || 'No tracked diff was returned. Do not infer a regression from the absence of a diff.',
      maxDiffCharacters,
      'Git diff',
    ),
    readmeContext ||
      '## Project README context\nNo README.md was found in the project or near the active file.',
    '## CodeBrain source, failure path, and blast radius',
    graphContext,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function guideEvidence(
  graphContext: string,
  editorContext: string,
  readmeContext: string,
  attachments: string,
): string {
  return [
    '## Feature requested and editor focus',
    editorContext || 'No active editor selection was supplied.',
    attachments,
    readmeContext ||
      '## Project README context\nNo README.md was found in the project or near the active file.',
    '## CodeBrain source and feature workflow evidence',
    graphContext,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  runtime: RuntimeCommand,
  indexManager: IndexManager,
  impactController: ImpactController,
  metrics: MetricsStore,
  reports: ReportManager,
  freshness: IndexFreshness,
  exploreCache: GraphCache<string>,
  log: (message: string) => void,
): void {
  const exploreDeps: ExploreDeps = { runtime, freshness, cache: exploreCache, log };
  const handler: vscode.ChatRequestHandler = async (
    request,
    chatContext,
    stream,
    token,
  ): Promise<CodeBrainChatResult> => {
    const command = inferCommand(request);
    const folder = getWorkspaceFolder();

    if (!folder) {
      stream.markdown(
        'CodeBrain needs an open filesystem-backed workspace before it can analyze code.',
      );
      return { metadata: { command } };
    }

    if (!hasIndex(folder)) {
      const responseLanguage = detectResponseLanguage(
        request.prompt,
        vscode.env.language,
      );
      if (responseLanguage.code === 'vi') {
        stream.markdown(
          'Workspace này chưa có index `.codegraph/`. Hãy bấm nút bên dưới để khởi tạo index 1-click, sau đó CodeBrain sẽ tự động phân tích đồ thị code.',
        );
        stream.button({
          command: 'codebrain.initializeWorkspace',
          title: '⚡ Khởi tạo CodeBrain Index',
        });
      } else {
        stream.markdown(
          'This workspace has no `.codegraph/` index yet. Click the button below to initialize it once, then CodeBrain will analyze the graph and keep it refreshed automatically.',
        );
        stream.button({
          command: 'codebrain.initializeWorkspace',
          title: '⚡ Initialize CodeBrain Index',
        });
      }
      return { metadata: { command } };
    }


    const config = vscode.workspace.getConfiguration('codebrain');
    const maxDiffCharacters = config.get<number>(
      'chat.maxDiffCharacters',
      120_000,
    );
    const showTokenUsage = config.get<boolean>('chat.showTokenUsage', true);
    const maxToolRounds = Math.max(
      0,
      Math.min(4, config.get<number>('chat.maxFollowUpLookups', 2)),
    );
    const editorContext = activeEditorContext(folder);
    // Context the user attached with `#file`, `#selection`, and friends. It is
    // a deliberate choice of focus, so it feeds both the graph query and the
    // evidence handed to the model.
    const attached = collectPromptReferences(
      request.references ?? [],
      folder.uri.fsPath,
    );
    const history = chatContext.history ?? [];
    // Take the language from the conversation, not just this message, so a bare
    // follow-up does not flip the report to another language mid-thread.
    const responseLanguage = detectConversationLanguage(
      historyPrompts(history, request.prompt),
      vscode.env.language,
    );
    const languageInstruction =
      responseLanguageInstruction(responseLanguage);
    /** Earlier turns of this thread, so follow-up questions resolve. */
    const priorMessages = historyMessages(history);
    const subject =
      request.prompt.trim() ||
      editorContext.split('\n')[0]?.replace(/^Active file:\s*/, '') ||
      'selected code';
    /** Prompt plus attachments, so the graph query looks where the user pointed. */
    const focusPrompt = [request.prompt, ...attached.hints]
      .filter(Boolean)
      .join(' ');

    try {
      const requestStartedAt = Date.now();
      // Say what is happening before the first lookup, not after it: sizing the
      // budget can cost a status call, and silence reads as a hung request.
      stream.progress(
        command === 'impact'
          ? 'Tracing change impact and detecting affected tests…'
          : command === 'review'
          ? 'Reviewing changed code, contracts, call paths, boundaries, and blast radius…'
          : command === 'fix'
          ? 'Tracing the bug, root cause, affected workflows, and safe solution…'
          : command === 'guide'
          ? 'Tracing the feature workflow and preparing a user guide…'
          : 'Tracing the workflow through CodeBrain…',
      );
      const maxFiles = await resolveMaxContextFiles(
        config,
        runtime,
        folder,
        freshness,
        token,
      );
      /** Lets the model pull in evidence the first lookup did not cover. */
      const expand = (query: string, files: number): Promise<string> =>
        explore(exploreDeps, folder, query, files, request, token);
      /** Options every command shares when asking the model for a report. */
      const reportBase = {
        request,
        languageInstruction,
        history: priorMessages,
        stream,
        defaultMaxFiles: maxFiles,
        progress: (message: string) => stream.progress(message),
      };

      let generatedReport: GeneratedReport;
      // Graph output backing the measured context-cost comparison in the footer.
      let evidenceContext = '';
      /** Files a review touched, shown as a navigable tree under the report. */
      let changedFiles: readonly string[] = [];
      if (command === 'impact') {
        const gitContext = await collectGitReviewContext(
          folder.uri.fsPath,
          maxDiffCharacters,
        );
        const query = buildReviewQuery(
          focusPrompt || 'Analyze change impact and affected tests.',
          gitContext,
          editorContext,
        );
        const graphContext = await explore(
          exploreDeps,
          folder,
          query,
          maxFiles,
          request,
          token,
        );
        evidenceContext = graphContext;
        const analysis = await impactController.analysisService.analyze(
          folder,
          token,
          graphContext,
        );
        impactController.setLatest(analysis);
        const deterministicReport = buildImpactMarkdown(
          analysis,
          responseLanguage.code,
        );
        // The deterministic half is already computed, so show it now rather
        // than making the user wait on the optional model interpretation.
        stream.markdown(`${deterministicReport.trim()}\n\n`);
        try {
          const aiExplanation = await generateReport(
            {
              ...reportBase,
              instructions: IMPACT_INSTRUCTIONS,
              userPrompt:
                request.prompt || 'Explain the deterministic change impact result.',
              evidence: [
                deterministicReport,
                attached.evidence,
                `## CodeBrain context\n\n${graphContext}`,
              ]
                .filter(Boolean)
                .join('\n\n'),
              codeBrainContext: graphContext,
              // The deterministic report is authoritative here, so extra
              // lookups cannot change the answer — only slow it down.
              expand: undefined,
            },
            token,
          );
          // Keep deterministic facts authoritative. The model contributes an
          // interpretation section instead of rewriting the impact score,
          // paths, tests, or evidence reported by the engine.
          generatedReport = {
            ...aiExplanation,
            text: `${deterministicReport.trim()}\n\n${aiExplanation.text.trim()}`,
          };
        } catch (error) {
          if (token.isCancellationRequested) throw error;
          // Impact facts remain useful when no chat model is available or the
          // optional explanation request fails.
          generatedReport = {
            text: deterministicReport,
            codeBrainContextTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            extraEvidence: '',
            toolRounds: 0,
          };
        }
      } else if (command === 'review') {
        const choice = await selectReviewCommit(folder.uri.fsPath, request.prompt);
        if (choice.cancelled) {
          stream.markdown('CodeBrain review cancelled.');
          return { metadata: { command } };
        }
        const selectedCommit = choice.commit;
        const gitContext = selectedCommit
          ? await collectGitCommitReviewContext(
              folder.uri.fsPath,
              selectedCommit,
              maxDiffCharacters,
            )
          : await collectGitReviewContext(
              folder.uri.fsPath,
              maxDiffCharacters,
            );
        const query = buildReviewQuery(
          selectedCommit
            ? `${focusPrompt} Review selected commit ${selectedCommit}.`
            : focusPrompt,
          gitContext,
          editorContext,
        );
        const graphContext = await explore(
          exploreDeps,
          folder,
          query,
          maxFiles,
          request,
          token,
        );
        evidenceContext = graphContext;
        changedFiles = gitContext.changedFiles;
        const readmeContext = readProjectReadmeContext(
          folder.uri.fsPath,
          editorContext,
        );
        generatedReport = await generateReport(
          {
            ...reportBase,
            instructions: customReviewPrompt(REVIEW_INSTRUCTIONS, folder),
            userPrompt:
              request.prompt || 'Review the current workspace changes or selected code.',
            evidence: reviewEvidence(
              graphContext,
              gitContext,
              editorContext,
              maxDiffCharacters,
              readmeContext,
              attached.evidence,
            ),
            codeBrainContext: graphContext,
            expand,
            maxToolRounds,
          },
          token,
        );
      } else if (command === 'guide') {
        const graphContext = await explore(
          exploreDeps,
          folder,
          buildGuideQuery(focusPrompt, editorContext),
          maxFiles,
          request,
          token,
        );
        evidenceContext = graphContext;
        const readmeContext = readProjectReadmeContext(
          folder.uri.fsPath,
          editorContext,
        );
        generatedReport = await generateReport(
          {
            ...reportBase,
            instructions: GUIDE_INSTRUCTIONS,
            userPrompt:
              request.prompt || 'Generate a user guide for the selected feature.',
            evidence: guideEvidence(
              graphContext,
              editorContext,
              readmeContext,
              attached.evidence,
            ),
            codeBrainContext: graphContext,
            expand,
            maxToolRounds,
          },
          token,
        );
      } else if (command === 'fix') {
        const gitContext = await collectGitReviewContext(
          folder.uri.fsPath,
          maxDiffCharacters,
        );
        const graphContext = await explore(
          exploreDeps,
          folder,
          buildFixQuery(focusPrompt, editorContext),
          maxFiles,
          request,
          token,
        );
        evidenceContext = graphContext;
        const readmeContext = readProjectReadmeContext(
          folder.uri.fsPath,
          editorContext,
        );
        generatedReport = await generateReport(
          {
            ...reportBase,
            instructions: FIX_INSTRUCTIONS,
            userPrompt:
              request.prompt || 'Analyze the bug in the selected code and propose a safe solution.',
            evidence: fixEvidence(
              graphContext,
              editorContext,
              readmeContext,
              gitContext,
              maxDiffCharacters,
              attached.evidence,
            ),
            codeBrainContext: graphContext,
            expand,
            maxToolRounds,
          },
          token,
        );
      } else {
        const query = buildExplainQuery(focusPrompt, editorContext);
        const graphContext = await explore(
          exploreDeps,
          folder,
          query,
          maxFiles,
          request,
          token,
        );
        evidenceContext = graphContext;
        const readmeContext = readProjectReadmeContext(
          folder.uri.fsPath,
          editorContext,
        );
        generatedReport = await generateReport(
          {
            ...reportBase,
            instructions: EXPLAIN_INSTRUCTIONS,
            userPrompt:
              request.prompt || 'Explain the purpose and workflow of the selected code.',
            evidence: explainEvidence(
              graphContext,
              editorContext,
              readmeContext,
              attached.evidence,
            ),
            codeBrainContext: graphContext,
            expand,
            maxToolRounds,
          },
          token,
        );
      }
      // Follow-up lookups are part of what the answer cost, so they belong in
      // the measured comparison alongside the first one.
      evidenceContext += generatedReport.extraEvidence;

      // Measure what reading the cited files in full would actually have cost,
      // instead of multiplying the context by a constant.
      const baseline = measureFileReadBaseline(
        folder.uri.fsPath,
        extractContextFilePaths(evidenceContext),
      );
      const tokenSample: ChatRequestTokenSample = {
        command,
        model: request.model.name,
        generatedAt: new Date().toISOString(),
        codeBrainContextTokens: generatedReport.codeBrainContextTokens,
        inputTokens: generatedReport.inputTokens,
        outputTokens: generatedReport.outputTokens,
        totalTokens: generatedReport.inputTokens + generatedReport.outputTokens,
        latencyMs: Date.now() - requestStartedAt,
        baselineTokens: baseline.tokens,
        baselineFiles: baseline.measuredFiles,
        baselineMeasured: baseline.measured,
      };
      try {
        await metrics.recordChatRequest(tokenSample);
      } catch {
        // Metrics are optional and must never hide an otherwise valid report.
      }
      // The chat has already shown the model's text as it arrived. The saved
      // copy is normalized: a guaranteed title and repaired Mermaid, which
      // matters in the Markdown preview — the place diagrams actually render.
      const normalizedReport = normalizeReport(
        command,
        generatedReport.text,
        subject,
      );
      // The token footer is a chat-time diagnostic, not part of the document.
      // Keeping it out of the stored copy means an exported guide or review
      // reads as a document rather than a document plus a cost readout.
      const reportUri = await reports.setLatest({
        kind: command,
        title:
          normalizedReport.match(/^#\s+(.+)$/m)?.[1] ??
          `CodeBrain ${command} report`,
        markdown: normalizedReport,
        folder,
      });

      if (!generatedReport.text.trim()) {
        // Nothing was streamed because the model returned nothing. Show the
        // normalized fallback rather than leaving the answer silently empty.
        stream.markdown(normalizedReport);
      }
      if (command === 'review' && changedFiles.length > 0) {
        stream.markdown(
          responseLanguage.code === 'vi'
            ? '\n\n**Tệp đã thay đổi:**\n\n'
            : '\n\n**Changed files:**\n\n',
        );
        stream.filetree(buildFileTree(changedFiles), folder.uri);
      }
      streamCodeAnchors(stream, folder, normalizedReport, responseLanguage.code);
      if (showTokenUsage) {
        stream.markdown(
          `\n\n${tokenUsageFooter(tokenSample, responseLanguage.code, {
            contextCharacters: evidenceContext.length,
          })}\n`,
        );
      }
      if (reportUri) {
        stream.reference(reportUri);
      }
      if (command === 'impact') {
        stream.button({
          command: 'codebrain.openWorkflowGraph',
          title: 'Open Workflow Graph',
        });
      }
      stream.button({
        command: 'codebrain.exportLatestMarkdown',
        title: 'Export Markdown',
      });
      return {
        metadata: {
          command,
          report: reportUri?.toString(),
          tokens: tokenSample,
        },
      };
    } catch (error) {
      if (token.isCancellationRequested) {
        stream.markdown('CodeBrain analysis was cancelled.');
        return { metadata: { command } };
      }

      const message = error instanceof Error ? error.message : String(error);
      stream.markdown(
        `CodeBrain could not complete the ${command} report: ${message}`,
      );
      return { metadata: { command } };
    }
  };

  const participant = vscode.chat.createChatParticipant('codebrain.chat', handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
  participant.followupProvider = {
    provideFollowups(result: CodeBrainChatResult) {
      if (result.metadata.command === 'impact') {
        return [
          {
            prompt: 'Review the highest-risk affected workflow.',
            label: 'Review highest-risk workflow',
            command: 'review',
          },
          {
            prompt: 'Explain how the affected tests cover this workflow.',
            label: 'Explain test coverage',
            command: 'explain',
          },
        ];
      }
      if (result.metadata.command === 'review') {
        return [
          {
            prompt: 'Explain the workflow behind the highest-risk finding.',
            label: 'Explain the highest-risk workflow',
            command: 'explain',
          },
          {
            prompt: 'Re-check the highest-risk finding across its contract, callers, boundary conditions, and missing tests.',
            label: 'Deepen highest-risk finding',
            command: 'review',
          },
          {
            // "commit" is what re-opens the commit picker, so it has to survive
            // into the prompt verbatim.
            prompt: 'Review a specific commit instead of the working tree.',
            label: 'Review a commit',
            command: 'review',
          },
        ];
      }
      if (result.metadata.command === 'fix') {
        return [
          {
            prompt: 'Review the proposed solution for regression risk and missing tests.',
            label: 'Review solution risk',
            command: 'review',
          },
          {
            prompt: 'Explain the failing workflow and root cause with more code-level detail.',
            label: 'Deepen root-cause analysis',
            command: 'explain',
          },
        ];
      }
      if (result.metadata.command === 'guide') {
        return [
          {
            // This re-runs /guide, so the label has to promise a new guide
            // rather than a review of the previous one.
            prompt:
              'Rewrite this guide with the prerequisites, permissions, and troubleshooting steps it is missing.',
            label: 'Fill the gaps in this guide',
            command: 'guide',
          },
          {
            prompt: 'Explain the implementation workflow behind this feature.',
            label: 'Explain implementation workflow',
            command: 'explain',
          },
        ];
      }
      return [
        {
          prompt: 'Review architecture, contracts, correctness, boundary safety, affected workflows, blast radius, missing tests, and release risk.',
          label: 'Run unified code review',
          command: 'review',
        },
      ];
    },
  };

  context.subscriptions.push(participant);

  context.subscriptions.push(
    vscode.commands.registerCommand('codebrain.chat.initialize', () =>
      indexManager.initialize(),
    ),
  );
}
