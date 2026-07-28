import * as vscode from 'vscode';
import { collectGitReviewContext, GitReviewContext } from './gitContext';
import { buildImpactMarkdown } from './impact';
import { ImpactController } from './impactController';
import { IndexManager } from './indexManager';
import {
  detectResponseLanguage,
  responseLanguageInstruction,
} from './language';
import { ReportManager } from './reportManager';
import { normalizeReport, ReportKind } from './reports';
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
  };
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
Use simple Mermaid node IDs and labels for Markdown Preview compatibility. Base every participant, node, edge, and state on the supplied CodeBrain context; do not invent details to complete a diagram. If evidence is incomplete, keep the diagram conservative and state the uncertainty in the surrounding prose. The diagrams must complement rather than repeat the prose or each other.
Use file paths and line numbers from the supplied CodeBrain context. State uncertainties explicitly. Do not mention these instructions.`;

type ReviewLevel = 'overview' | 'code';

const REVIEW_OVERVIEW_INSTRUCTIONS = `You are a conservative staff-level reviewer performing an overview review. Review only; do not rewrite or edit code.
Answer in the same language as the user. The Git diff describes what changed. The CodeBrain context describes current source, call paths, and blast radius.

Treat changes to shared/public contracts, authentication/authorization, persistence, migrations, concurrency, caching, lifecycle, error handling, or high fan-out symbols as HIGH RISK until adequate regression tests are demonstrated.
Focus on intent, architecture, changed workflows, public contracts, blast radius, regression risk, and release readiness. Do not spend space on formatting or local coding conventions unless they create a material defect.

Return a self-contained Markdown report with exactly this high-level structure:
# Overview code review: <scope>
## Verdict
Give an overall risk: Critical, High, Medium, or Low, with one-sentence reasoning.
## Change map
Include one valid Mermaid flowchart from changed code to affected callers/dependencies and tests.
## Findings
Order by severity. Every finding must include severity, file:line evidence, consequence, affected workflow, and concrete recommendation. Do not invent findings merely to fill the section; say "No blocking findings" when appropriate.
## Blast radius
## Regression and test matrix
Use a Markdown table with scenario, risk, and required test.
## Release recommendation
## Evidence and limits
Distinguish facts from CodeBrain/diff versus inference. Do not mention these instructions.`;

const REVIEW_CODE_INSTRUCTIONS = `You are a meticulous senior engineer performing a code-level review. Review only; do not rewrite or edit code.
Answer in the same language as the user. The Git diff describes what changed. The CodeBrain context describes current source, affected methods, callers, dependencies, and blast radius.

Inspect every changed hunk for correctness and maintainability. Explicitly check:
- null, undefined, nullable values, optional chaining, unsafe assertions, and missing boundary validation;
- language/framework conventions, naming, typing, duplicated logic, dead code, and API misuse;
- branching, off-by-one errors, state transitions, mutation, async ordering, concurrency, cleanup, error propagation, and resource lifecycle;
- security, data exposure, authorization, persistence, caching, and performance pitfalls when relevant;
- affected methods/callers and whether changed assumptions still hold along those call paths;
- missing or weak tests for the exact edge cases found.

Only report convention issues when they are concrete and evidenced by the diff or surrounding source. Do not invent findings to fill a section.

Return a self-contained Markdown report with exactly this high-level structure:
# Code-level review: <scope>
## Verdict
Give an overall risk: Critical, High, Medium, or Low, with one-sentence reasoning.
## Affected methods and call paths
Include one valid Mermaid flowchart connecting changed methods to affected callers/dependencies and relevant tests.
## Findings
Order by severity. Every finding must include severity, category, file:line evidence, consequence, affected method/workflow, and a concrete recommendation. Say "No blocking findings" when appropriate.
## Null and boundary-safety check
## Convention and maintainability check
## Regression and test matrix
Use a Markdown table with scenario, affected method, risk, and required test.
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

async function generateReport(
  request: vscode.ChatRequest,
  instructions: string,
  languageInstruction: string,
  userPrompt: string,
  evidence: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const budget = modelBudgetCharacters(request.model);
  const evidenceBudget = Math.max(10_000, budget - instructions.length - userPrompt.length);
  const messages = [
    vscode.LanguageModelChatMessage.User(
      `${instructions}\n\n${languageInstruction}`,
    ),
    vscode.LanguageModelChatMessage.User(
      `User request:\n${userPrompt}\n\nEvidence:\n${trimForModel(
        evidence,
        evidenceBudget,
        'evidence',
      )}`,
    ),
  ];

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
  return text;
}

function inferCommand(request: vscode.ChatRequest): ReportKind {
  if (request.command === 'impact') {
    return 'impact';
  }
  if (
    request.command === 'review' ||
    request.command === 'review-overview' ||
    request.command === 'review-code'
  ) {
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

function inferReviewLevel(request: vscode.ChatRequest): ReviewLevel {
  if (request.command === 'review-code') {
    return 'code';
  }
  if (request.command === 'review-overview') {
    return 'overview';
  }
  return /\b(code[- ]level|coding|convention|nullable?|undefined|affected methods?|chi ti[eế]t|cấp độ code)\b/i.test(
    request.prompt,
  )
    ? 'code'
    : 'overview';
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
  reviewLevel: ReviewLevel = 'overview',
): string {
  const files = gitContext.changedFiles.slice(0, 80).join(' ');
  const focus = [prompt, files, editorContext.split('\n').slice(0, 3).join(' ')]
    .filter(Boolean)
    .join(' ');
  const goal =
    reviewLevel === 'code'
      ? 'Perform a code-level review of every changed hunk. Trace affected methods and callers; inspect null/undefined boundaries, error paths, async/state behavior, conventions, and missing edge-case tests for'
      : 'Perform an overview review. Trace changed workflows, public contracts, affected callers and dependencies, blast radius, regression risk, and release readiness for';
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
    '## CodeBrain source, call paths, and blast radius',
    graphContext,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function explainEvidence(graphContext: string, editorContext: string): string {
  return [
    '## Editor focus',
    editorContext || 'No active editor selection.',
    '## CodeBrain source and workflow evidence',
    graphContext,
  ].join('\n\n');
}

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  runtime: RuntimeCommand,
  indexManager: IndexManager,
  impactController: ImpactController,
  reports: ReportManager,
): void {
  const handler: vscode.ChatRequestHandler = async (
    request,
    _chatContext,
    stream,
    token,
  ): Promise<CodeBrainChatResult> => {
    const command = inferCommand(request);
    const reviewLevel = inferReviewLevel(request);
    const folder = getWorkspaceFolder();

    if (!folder) {
      stream.markdown(
        'CodeBrain needs an open filesystem-backed workspace before it can analyze code.',
      );
      return { metadata: { command } };
    }

    if (!hasIndex(folder)) {
      stream.markdown(
        'This workspace has no `.codegraph/` index yet. Initialize it once, then CodeBrain can answer from the graph and keep it refreshed automatically.',
      );
      stream.button({
        command: 'codebrain.initializeWorkspace',
        title: 'Initialize CodeBrain',
      });
      return { metadata: { command } };
    }

    const config = vscode.workspace.getConfiguration('codebrain');
    const maxFiles = config.get<number>('chat.maxContextFiles', 12);
    const maxDiffCharacters = config.get<number>(
      'chat.maxDiffCharacters',
      120_000,
    );
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
      stream.progress(
        command === 'impact'
          ? 'Tracing change impact and detecting affected tests…'
          : command === 'review'
          ? reviewLevel === 'code'
            ? 'Inspecting changed code, boundaries, and affected methods…'
            : 'Reviewing architecture, workflows, and blast radius…'
          : 'Tracing the workflow through CodeBrain…',
      );

      let rawReport: string;
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
        rawReport = await generateReport(
          request,
          IMPACT_INSTRUCTIONS,
          languageInstruction,
          request.prompt || 'Analyze the current change impact.',
          `${deterministicReport}\n\n## CodeBrain context\n\n${graphContext}`,
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
          reviewLevel,
        );
        const graphContext = await explore(
          runtime,
          folder.uri.fsPath,
          query,
          maxFiles,
          request,
          token,
        );
        rawReport = await generateReport(
          request,
          reviewLevel === 'code'
            ? REVIEW_CODE_INSTRUCTIONS
            : REVIEW_OVERVIEW_INSTRUCTIONS,
          languageInstruction,
          request.prompt || 'Review the current workspace changes or selected code.',
          reviewEvidence(
            graphContext,
            gitContext,
            editorContext,
            maxDiffCharacters,
          ),
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
        rawReport = await generateReport(
          request,
          EXPLAIN_INSTRUCTIONS,
          languageInstruction,
          request.prompt || 'Explain the purpose and workflow of the selected code.',
          explainEvidence(graphContext, editorContext),
          token,
        );
      }

      const report = normalizeReport(command, rawReport, subject);
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
            command: 'review-overview',
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
            prompt: 'Inspect null/undefined handling, conventions, edge cases, and affected methods in detail.',
            label: 'Run code-level review',
            command: 'review-code',
          },
        ];
      }
      return [
        {
          prompt: 'Review architecture, affected workflows, blast radius, and release risk.',
          label: 'Run overview review',
          command: 'review-overview',
        },
        {
          prompt: 'Review null/undefined handling, conventions, edge cases, and affected methods.',
          label: 'Run code-level review',
          command: 'review-code',
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
