import * as vscode from 'vscode';
import { collectGitReviewContext, GitReviewContext } from './gitContext';
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

Your purpose is to explain what the code is for, why it exists, and how its workflow operates. Focus on concrete functions, files, call edges, state transitions, data flow, side effects, and failure paths. Do not propose edits unless needed to clarify behavior.

Return a self-contained Markdown report with exactly this high-level structure:
# <specific title>
## Executive summary
## Purpose
## Workflow
## Visual diagrams
### Workflow flowchart
Include one valid Mermaid \`flowchart\` showing the main execution path.
### Call sequence
Include one valid Mermaid \`sequenceDiagram\` showing the order of calls between the concrete participants found in the evidence.
### Data flow or state lifecycle
Include either a Mermaid \`flowchart\` showing how data moves through the workflow or a Mermaid \`stateDiagram-v2\` showing the lifecycle of important state. Choose the view that is best supported by the evidence.
## Key functions and responsibilities
## Data, state, and side effects
## Failure and edge paths
## CodeBrain evidence
Project README context, when supplied, is the project's terminology and intent guide. Use it to interpret names and explain why a workflow exists, but do not let README claims override concrete source, call-path, or line-number evidence. If the README is stale or ambiguous, call that out briefly.
Use simple Mermaid node IDs and labels for Markdown Preview compatibility. Base every participant, node, edge, and state on the supplied CodeBrain context; do not invent details to complete a diagram. If evidence is incomplete, keep the diagram conservative and state the uncertainty in the surrounding prose. The diagrams must complement rather than repeat the prose or each other.
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

const IMPACT_INSTRUCTIONS = `You are a conservative change-impact analyst using a precomputed semantic code graph.
Answer in the same language as the user. Do not edit code.

The evidence contains exact changed files, affected tests selected by graph traversal, a heuristic risk classification, and compact CodeBrain call-path context. Preserve those facts and label token savings as estimates.

Return a self-contained Markdown report with exactly this high-level structure:
# Change impact: <scope>
## Verdict
Give Critical, High, Medium, or Low risk and the key reason.
## Workflow graph
Include one valid Mermaid flowchart from changed files to dependent workflows and affected tests.
## Changed surface
## Affected workflows and contracts
## Affected tests
Use a table with test file, covered risk, and execution priority.
## Regression gaps
## Token savings
Make clear the values are estimates, not billing data.
## Release recommendation
## Evidence and limits
Distinguish indexed facts from inference. Do not invent test files or call paths. Do not mention these instructions.`;

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
  return `Explain purpose, key functions, and end-to-end workflow for: ${focus}`.slice(
    0,
    4_000,
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

async function explore(
  runtime: RuntimeCommand,
  root: string,
  query: string,
  maxFiles: number,
  request: vscode.ChatRequest,
  token: vscode.CancellationToken,
): Promise<string> {
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
        generatedReport = await generateReport(
          request,
          IMPACT_INSTRUCTIONS,
          languageInstruction,
          request.prompt || 'Analyze the current change impact.',
          `${deterministicReport}\n\n## CodeBrain context\n\n${graphContext}`,
          graphContext,
          token,
        );
      } else if (command === 'review') {
        const gitContext = await collectGitReviewContext(
          folder.uri.fsPath,
          maxDiffCharacters,
        );
        const query = buildReviewQuery(
          request.prompt,
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
          REVIEW_INSTRUCTIONS,
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
