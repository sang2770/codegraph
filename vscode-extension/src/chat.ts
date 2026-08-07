import * as vscode from 'vscode';
import {
  collectGitCommitReviewContext,
  collectGitReviewContext,
  GitReviewContext,
  listGitCommits,
} from './gitContext';
import { buildImpactMarkdown } from './impact';
import { ImpactController } from './impactController';
import { IndexManager } from './indexManager';
import {
  detectResponseLanguage,
  responseLanguageInstruction,
} from './language';
import {
  ChatRequestTokenSample,
  MetricsStore,
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

async function generateReport(
  request: vscode.ChatRequest,
  instructions: string,
  languageInstruction: string,
  userPrompt: string,
  evidence: string,
  codeBrainContext: string,
  token: vscode.CancellationToken,
): Promise<GeneratedReport> {
  const budget = modelBudgetCharacters(request.model);
  const evidenceBudget = Math.max(10_000, budget - instructions.length - userPrompt.length);
  const instructionText = `${instructions}\n\n${languageInstruction}`;
  const requestText = `User request:\n${userPrompt}\n\nEvidence:\n${trimForModel(
    evidence,
    evidenceBudget,
    'evidence',
  )}`;
  const messages = [
    vscode.LanguageModelChatMessage.User(instructionText),
    vscode.LanguageModelChatMessage.User(requestText),
  ];
  const [inputTokens, codeBrainContextTokens] = await Promise.all([
    countTokens(request.model, `${instructionText}\n\n${requestText}`, token),
    countTokens(request.model, codeBrainContext, token),
  ]);

  const response = await request.model.sendRequest(
    messages,
    {
      justification:
        'Generate a local CodeBrain workflow explanation or code review requested by the user.',
    },
    token,
  );

  let text = '';
  for await (const fragment of response.text) {
    text += fragment;
  }
  const outputTokens = await countTokens(request.model, text, token);
  return {
    text,
    codeBrainContextTokens,
    inputTokens,
    outputTokens,
  };
}

function tokenUsageFooter(
  sample: ChatRequestTokenSample,
  languageCode: string,
): string {
  const locale = languageCode === 'vi' ? 'vi-VN' : 'en-US';
  const format = (value: number) => new Intl.NumberFormat(locale).format(value);
  const baselineTokens = Math.round(sample.codeBrainContextTokens * 6.5);
  const savedTokens = Math.max(0, baselineTokens - sample.codeBrainContextTokens);
  const percentSaved = baselineTokens > 0 ? Math.round((savedTokens / baselineTokens) * 100) : 0;

  if (languageCode === 'vi') {
    return [
      '---',
      `> 📊 **Báo cáo Hiệu năng CodeBrain (Ước tính)**`,
      `> * 🟢 **Token nạp bởi CodeBrain:** **${format(sample.codeBrainContextTokens)}**`,
      `> * 🔴 **Token nếu đọc thô (Grep/Read):** **${format(baselineTokens)}**`,
      `> * ⚡ **Tiết kiệm:** **~${percentSaved}% (${format(savedTokens)} tokens)** · Thời gian: **${format(sample.latencyMs)} ms**`,
      '>',
      '> Không phải dữ liệu billing; số token do model provider đếm và có thể không gồm hidden/system overhead.',
    ].join('\n');
  }
  return [
    '---',
    `> 📊 **CodeBrain Performance Summary (Estimated)**`,
    `> * 🟢 **CodeBrain Context Tokens:** **${format(sample.codeBrainContextTokens)}**`,
    `> * 🔴 **Unindexed Grep/Read Baseline:** **${format(baselineTokens)}**`,
    `> * ⚡ **Savings:** **~${percentSaved}% (${format(savedTokens)} tokens)** · Latency: **${format(sample.latencyMs)} ms**`,
    '>',
    '> Not billing data; counts come from the model provider and may exclude hidden/system overhead.',
  ].join('\n');
}


function inferCommand(request: vscode.ChatRequest): ReportKind {
  if (request.command === 'impact') {
    return 'impact';
  }
  if (request.command === 'review') {
    return 'review';
  }
  if (request.command === 'explain') {
    return 'explain';
  }
  if (request.command === 'fix') {
    return 'fix';
  }
  if (request.command === 'guide') {
    return 'guide';
  }
  if (/\b(fix|bug|debug|root cause|cause|solution|lỗi|nguyên nhân|giải pháp)\b/i.test(request.prompt)) {
    return 'fix';
  }
  if (
    /\b(impact|affected tests?|change impact|ảnh hưởng|test bị ảnh hưởng)\b/i.test(
      request.prompt,
    )
  ) {
    return 'impact';
  }
  return /\b(review|diff|risk|regression|blast radius|rủi ro|đánh giá)\b/i.test(
    request.prompt,
  )
    ? 'review'
    : 'explain';
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

async function explore(
  runtime: RuntimeCommand,
  root: string,
  query: string,
  maxFiles: number,
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
): Promise<string> {
  const refreshBeforeAnalysis = vscode.workspace
    .getConfiguration('codebrain')
    .get<boolean>('review.refreshIndexBeforeRun', true);
  if (refreshBeforeAnalysis) {
    const refreshResult = await runCodeBrain(
      runtime,
      ['sync', root],
      {
        cwd: root,
        env: codeBrainEnvironment(),
        token,
      },
    );
    if (refreshResult.code !== 0) {
      throw new Error(
        refreshResult.stderr.trim() ||
          refreshResult.stdout.trim() ||
          'CodeBrain index refresh failed; analysis was not started against a stale index.',
      );
    }
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
        return text;
      }
    } catch {
      // MCP discovery/activation is best-effort here. The bundled CLI below is
      // the same CodeBrain engine and output surface, so reports still work.
    }
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
  return result.stdout;
}

function reviewEvidence(
  graphContext: string,
  gitContext: GitReviewContext,
  editorContext: string,
  maxDiffCharacters: number,
  readmeContext: string,
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
    readmeContext ||
      '## Project README context\nNo README.md was found in the project or near the active file.',
    '## CodeBrain source, call paths, and blast radius',
    graphContext,
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function selectReviewCommit(
  root: string,
  prompt: string,
): Promise<string | undefined> {
  const explicit = prompt.match(
    /(?:commit|changeset|sha)\s+([0-9a-f]{7,40})\b/i,
  )?.[1] ?? prompt.match(/^\s*([0-9a-f]{7,40})\s*$/i)?.[1];
  if (explicit) return explicit;

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
  if (!selected || selected === items[0]) return undefined;
  return selected.description || undefined;
}

function explainEvidence(
  graphContext: string,
  editorContext: string,
  readmeContext: string,
): string {
  return [
    '## Editor focus',
    editorContext || 'No active editor selection.',
    readmeContext ||
      '## Project README context\nNo README.md was found in the project or near the active file.',
    '## CodeBrain source and workflow evidence',
    graphContext,
  ].join('\n\n');
}

function fixEvidence(
  graphContext: string,
  editorContext: string,
  readmeContext: string,
  gitContext: GitReviewContext,
  maxDiffCharacters: number,
): string {
  return [
    '## Reported bug and editor focus',
    editorContext || 'No active editor selection or runtime error was supplied.',
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
  ].join('\n\n');
}

function guideEvidence(
  graphContext: string,
  editorContext: string,
  readmeContext: string,
): string {
  return [
    '## Feature requested and editor focus',
    editorContext || 'No active editor selection was supplied.',
    readmeContext ||
      '## Project README context\nNo README.md was found in the project or near the active file.',
    '## CodeBrain source and feature workflow evidence',
    graphContext,
  ].join('\n\n');
}

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  runtime: RuntimeCommand,
  indexManager: IndexManager,
  impactController: ImpactController,
  metrics: MetricsStore,
  reports: ReportManager,
): void {
  const handler: vscode.ChatRequestHandler = async (
    request,
    _chatContext,
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
    const maxFiles = config.get<number>('chat.maxContextFiles', 12);
    const maxDiffCharacters = config.get<number>(
      'chat.maxDiffCharacters',
      120_000,
    );
    const showTokenUsage = config.get<boolean>('chat.showTokenUsage', true);
    const editorContext = activeEditorContext(folder);
    const responseLanguage = detectResponseLanguage(
      request.prompt,
      vscode.env.language,
    );
    const languageInstruction =
      responseLanguageInstruction(responseLanguage);
    const subject =
      request.prompt.trim() ||
      editorContext.split('\n')[0]?.replace(/^Active file:\s*/, '') ||
      'selected code';

    try {
      const requestStartedAt = Date.now();
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

      let generatedReport: GeneratedReport;
      if (command === 'impact') {
        const gitContext = await collectGitReviewContext(
          folder.uri.fsPath,
          maxDiffCharacters,
        );
        const query = buildReviewQuery(
          request.prompt || 'Analyze change impact and affected tests.',
          gitContext,
          editorContext,
        );
        const graphContext = await explore(
          runtime,
          folder.uri.fsPath,
          query,
          maxFiles,
          request,
          token,
        );
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
        try {
          const aiExplanation = await generateReport(
            request,
            IMPACT_INSTRUCTIONS,
            languageInstruction,
            request.prompt || 'Explain the deterministic change impact result.',
            `${deterministicReport}\n\n## CodeBrain context\n\n${graphContext}`,
            graphContext,
            token,
          );
          // Keep deterministic facts authoritative. The model contributes an
          // interpretation section instead of rewriting the impact score,
          // paths, tests, or evidence reported by the engine.
          generatedReport = {
            text: `${deterministicReport.trim()}\n\n${aiExplanation.text.trim()}`,
            codeBrainContextTokens: aiExplanation.codeBrainContextTokens,
            inputTokens: aiExplanation.inputTokens,
            outputTokens: aiExplanation.outputTokens,
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
          };
        }
      } else if (command === 'review') {
        const selectedCommit = await selectReviewCommit(
          folder.uri.fsPath,
          request.prompt,
        );
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
            ? `${request.prompt} Review selected commit ${selectedCommit}.`
            : request.prompt,
          gitContext,
          editorContext,
        );
        const graphContext = await explore(
          runtime,
          folder.uri.fsPath,
          query,
          maxFiles,
          request,
          token,
        );
        const readmeContext = readProjectReadmeContext(
          folder.uri.fsPath,
          editorContext,
        );
        generatedReport = await generateReport(
          request,
          customReviewPrompt(REVIEW_INSTRUCTIONS, folder),
          languageInstruction,
          request.prompt || 'Review the current workspace changes or selected code.',
          reviewEvidence(
            graphContext,
            gitContext,
            editorContext,
            maxDiffCharacters,
            readmeContext,
          ),
          graphContext,
          token,
        );
      } else if (command === 'guide') {
        const graphContext = await explore(
          runtime,
          folder.uri.fsPath,
          buildGuideQuery(request.prompt, editorContext),
          maxFiles,
          request,
          token,
        );
        const readmeContext = readProjectReadmeContext(
          folder.uri.fsPath,
          editorContext,
        );
        generatedReport = await generateReport(
          request,
          GUIDE_INSTRUCTIONS,
          languageInstruction,
          request.prompt || 'Generate a user guide for the selected feature.',
          guideEvidence(graphContext, editorContext, readmeContext),
          graphContext,
          token,
        );
      } else if (command === 'fix') {
        const gitContext = await collectGitReviewContext(
          folder.uri.fsPath,
          maxDiffCharacters,
        );
        const graphContext = await explore(
          runtime,
          folder.uri.fsPath,
          buildFixQuery(request.prompt, editorContext),
          maxFiles,
          request,
          token,
        );
        const readmeContext = readProjectReadmeContext(
          folder.uri.fsPath,
          editorContext,
        );
        generatedReport = await generateReport(
          request,
          FIX_INSTRUCTIONS,
          languageInstruction,
          request.prompt || 'Analyze the bug in the selected code and propose a safe solution.',
          fixEvidence(
            graphContext,
            editorContext,
            readmeContext,
            gitContext,
            maxDiffCharacters,
          ),
          graphContext,
          token,
        );
      } else {
        const query = buildExplainQuery(request.prompt, editorContext);
        const graphContext = await explore(
          runtime,
          folder.uri.fsPath,
          query,
          maxFiles,
          request,
          token,
        );
        const readmeContext = readProjectReadmeContext(
          folder.uri.fsPath,
          editorContext,
        );
        generatedReport = await generateReport(
          request,
          EXPLAIN_INSTRUCTIONS,
          languageInstruction,
          request.prompt || 'Explain the purpose and workflow of the selected code.',
          explainEvidence(graphContext, editorContext, readmeContext),
          graphContext,
          token,
        );
      }

      const tokenSample: ChatRequestTokenSample = {
        command,
        model: request.model.name,
        generatedAt: new Date().toISOString(),
        codeBrainContextTokens: generatedReport.codeBrainContextTokens,
        inputTokens: generatedReport.inputTokens,
        outputTokens: generatedReport.outputTokens,
        totalTokens: generatedReport.inputTokens + generatedReport.outputTokens,
        latencyMs: Date.now() - requestStartedAt,
      };
      try {
        await metrics.recordChatRequest(tokenSample);
      } catch {
        // Metrics are optional and must never hide an otherwise valid report.
      }
      const normalizedReport = normalizeReport(
        command,
        generatedReport.text,
        subject,
      );
      const report = showTokenUsage
        ? `${normalizedReport.trim()}\n\n${tokenUsageFooter(
            tokenSample,
            responseLanguage.code,
          )}\n`
        : normalizedReport;
      const reportUri = await reports.setLatest({
        kind: command,
        title:
          report.match(/^#\s+(.+)$/m)?.[1] ??
          `CodeBrain ${command} report`,
        markdown: report,
        folder,
      });
      stream.markdown(report);
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
            prompt: 'Review this guide for missing prerequisites, permissions, and troubleshooting steps.',
            label: 'Review guide completeness',
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
