import { resolve } from 'node:path';
import * as vscode from 'vscode';
import { collectGitReviewContext } from './gitContext';
import { ImpactAnalysis, ImpactAnalysisService } from './impact';
import { selectCodeBrainModel } from './modelSelection';
import { ReportManager } from './reportManager';
import { getWorkspaceFolder, hasIndex } from './workspace';

const MAX_REVIEW_EVIDENCE = 100_000;
let reviewDiagnostics: vscode.DiagnosticCollection | undefined;
let reviewLocations: vscode.Location[] = [];
let reviewIndex = -1;
let reviewCommentController: vscode.CommentController | undefined;
let reviewCommentThreads: vscode.CommentThread[] = [];
let reviewAvatar: vscode.Uri | undefined;
let reviewHighlightDecorations = new Map<string, vscode.TextEditorDecorationType>();
let reviewLocationSeverities: string[] = [];

export function configureReviewUi(extensionUri: vscode.Uri): void {
  reviewAvatar = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
  for (const [severity, color] of [
    ['critical', 'editorError.background'],
    ['high', 'editorError.background'],
    ['medium', 'editorWarning.background'],
    ['low', 'editorInfo.background'],
  ] as const) {
    reviewHighlightDecorations.set(
      severity,
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor(color),
        overviewRulerColor: new vscode.ThemeColor(
          severity === 'low'
            ? 'editorOverviewRuler.infoForeground'
            : severity === 'medium'
              ? 'editorOverviewRuler.warningForeground'
              : 'editorOverviewRuler.errorForeground',
        ),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
      }),
    );
  }
}

function refreshReviewHighlights(): void {
  if (reviewHighlightDecorations.size === 0) return;
  for (const editor of vscode.window.visibleTextEditors) {
    for (const [severity, decoration] of reviewHighlightDecorations) {
      const ranges = reviewLocations
        .filter((location, index) =>
          location.uri.toString() === editor.document.uri.toString() &&
          reviewLocationSeverities[index] === severity,
        )
        .map((location) => location.range);
      editor.setDecorations(decoration, ranges);
    }
  }
}

function clearReviewComments(): void {
  for (const thread of reviewCommentThreads) thread.dispose();
  reviewCommentThreads = [];
}

function conciseFindingBody(body: string): string {
  const text = body.replace(/<!--[^>]*-->/g, '').trim();
  const impact = text.match(/(?:impact|consequence|affected workflow)\s*:\s*(.+?)(?=\n\s*(?:\*{0,2}recommendation|\*{0,2}fix|\*{0,2}suggestion)\s*:|$)/is)?.[1]?.trim();
  const recommendation = text.match(/(?:recommendation|fix|suggestion)\s*:\s*(.+)$/is)?.[1]?.trim();
  const fallback = text.split(/\n+/).map((line) => line.trim()).find(Boolean) ?? '';
  const lines = [`**Impact:** ${impact || fallback || 'The review identified a potential issue on this line.'}`];
  if (recommendation) lines.push(`**Recommendation:** ${recommendation}`);
  return lines.join('\n\n').slice(0, 2_000);
}

function publishReviewComment(
  uri: vscode.Uri,
  range: vscode.Range,
  severity: string,
  file: string,
  body: string,
): void {
  reviewCommentController ??= vscode.comments.createCommentController(
    'codebrain-review',
    'CodeBrain Review',
  );
  const comment = {
    body: new vscode.MarkdownString(
      `**${severity.toUpperCase()}** · \`${file}\`\n\n${conciseFindingBody(body)}`,
    ),
    mode: vscode.CommentMode.Preview,
    author: { name: 'CodeBrain Review', iconPath: reviewAvatar },
  } satisfies vscode.Comment;
  const thread = reviewCommentController.createCommentThread(uri, range, [comment]);
  thread.canReply = false;
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  thread.label = 'CodeBrain Review';
  thread.contextValue = 'codebrainReview';
  reviewCommentThreads.push(thread);
}

export function navigateReviewFinding(direction: 1 | -1): void {
  if (reviewLocations.length === 0) {
    void vscode.window.showInformationMessage(
      'This review does not have any findings to navigate.',
    );
    return;
  }
  const editor = vscode.window.activeTextEditor;
  const currentIndex = editor
    ? reviewLocations.findIndex(
        (location) =>
          location.uri.toString() === editor.document.uri.toString() &&
          location.range.start.line === editor.selection.active.line,
      )
    : -1;
  const baseIndex = currentIndex >= 0 ? currentIndex : reviewIndex;
  const index = (baseIndex + direction + reviewLocations.length) % reviewLocations.length;
  const location = reviewLocations[index];
  if (!location) return;
  reviewIndex = index;
  void vscode.window.showTextDocument(location.uri, {
    selection: location.range,
    viewColumn: vscode.ViewColumn.Active,
  }).then((editor) => {
    refreshReviewHighlights();
    const severity = reviewLocationSeverities[reviewIndex] ?? 'high';
    const decoration = reviewHighlightDecorations.get(severity);
    if (decoration) {
      editor.setDecorations(decoration, [location.range]);
    }
  });
}

function trimEvidence(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n\n[Evidence truncated by CodeBrain.]`;
}

function reviewPrompt(analysis: ImpactAnalysis, diff: string): string {
  const signals = analysis.assessment.signals
    .map((signal) => `- ${signal.label}: ${signal.score}/${signal.maxScore} — ${signal.detail}`)
    .join('\n');
  return `You are CodeBrain Review, an independent code review engine. Review the current Git changes using both the diff and the semantic graph evidence below.

Return a concise Markdown review with exactly these sections:
# CodeBrain Review
## Verdict
State whether the change is safe to merge, needs changes, or needs tests first. Include risk level ${analysis.risk.toUpperCase()} (${analysis.assessment.score}/${analysis.assessment.maxScore}).
## Findings
For each finding add this marker on its own line: <!-- codebrain-finding severity="high" file="src/file.ts" line="42" -->. Under each marker use exactly these concise labels: **Impact:** one sentence explaining what can break; **Recommendation:** one actionable fix or test, when needed. Do not invent findings.
## Affected workflows
Explain the highest-risk callers/dependents and distinguish direct from transitive impact when evidence allows.
## Test plan
List affected tests and missing coverage. Never interpret zero indexed tests as proof of no risk.
## Merge recommendation
Give one actionable next step.

Risk signals:
${signals}

Changed files: ${analysis.changedFiles.join(', ') || 'none'}
Affected tests: ${analysis.affectedTests.join(', ') || 'none detected'}
Dependent workflows: ${analysis.totalDependentsTraversed}

## Git diff
${trimEvidence(diff || 'No Git diff was returned.', MAX_REVIEW_EVIDENCE)}

## CodeBrain graph evidence
${trimEvidence(analysis.graphContext || 'No graph evidence was returned.', MAX_REVIEW_EVIDENCE)}

Treat the Git diff as the source of truth for what changed. Treat graph evidence as supporting context. Be explicit about uncertainty.`;
}

function publishInlineFindings(
  folder: vscode.WorkspaceFolder,
  markdown: string,
): void {
  reviewDiagnostics?.clear();
  reviewLocations = [];
  reviewIndex = -1;
  reviewLocationSeverities = [];
  clearReviewComments();
  refreshReviewHighlights();
  void vscode.commands.executeCommand('setContext', 'codebrain.reviewFindings', false);
  reviewDiagnostics ??= vscode.languages.createDiagnosticCollection('codebrain-review');
  const pattern = /<!--\s*codebrain-finding\s+severity="(critical|high|medium|low)"\s+file="([^"]+)"\s+line="(\d+)"\s*-->([\s\S]*?)(?=<!--\s*codebrain-finding|$)/gi;
  const byFile = new Map<string, vscode.Diagnostic[]>();
  const matches: Array<{ severity: string; file: string; line: string; body: string }> = [];
  for (const match of markdown.matchAll(pattern)) {
    const [, severity, file, line, body] = match;
    if (severity && file && line && body !== undefined) {
      matches.push({ severity, file, line, body });
    }
  }
  const fallbackPattern = /^(?:\s*(?:[-*]\s*)?(?:#{1,6}\s*)?)\*{0,2}(critical|high|medium|low)\*{0,2}\s*(?:[—:-])\s*[`"]?(.+?)[`"]?(?::|,\s*line\s+)(\d+)\b.*$/gim;
  if (matches.length === 0) {
    for (const match of markdown.matchAll(fallbackPattern)) {
      const [, severity, file, line] = match;
      if (severity && file && line) {
        matches.push({ severity, file, line, body: match[0] });
      }
    }
  }
  for (const match of matches) {
    const severity = match.severity.toLowerCase();
    const line = Math.max(1, Number.parseInt(match.line, 10));
    const uri = vscode.Uri.file(resolve(folder.uri.fsPath, match.file));
    const diagnosticSeverity =
      severity === 'critical' || severity === 'high'
        ? vscode.DiagnosticSeverity.Error
        : severity === 'medium'
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER),
      match.body.trim().slice(0, 1_000) || `CodeBrain ${severity} finding`,
      diagnosticSeverity,
    );
    diagnostic.source = 'CodeBrain Review';
    reviewLocations.push(new vscode.Location(uri, diagnostic.range));
    reviewLocationSeverities.push(severity);
    publishReviewComment(
      uri,
      diagnostic.range,
      severity,
      match.file,
      match.body.split(/^##\s+/m, 1)[0] ?? '',
    );
    const existing = byFile.get(uri.toString()) ?? [];
    existing.push(diagnostic);
    byFile.set(uri.toString(), existing);
  }
  for (const [uri, diagnostics] of byFile) {
    reviewDiagnostics.set(vscode.Uri.parse(uri), diagnostics);
  }
  if (reviewLocations.length > 0) {
    reviewIndex = 0;
    void vscode.commands.executeCommand('setContext', 'codebrain.reviewFindings', true);
    refreshReviewHighlights();
  }
}

function addFindingLinks(folder: vscode.WorkspaceFolder, markdown: string): string {
  return markdown.replace(
    /<!--\s*codebrain-finding\s+severity="(?:critical|high|medium|low)"\s+file="([^"]+)"\s+line="(\d+)"\s*-->/gi,
    (_marker, file: string, line: string) => {
      const uri = vscode.Uri.file(resolve(folder.uri.fsPath, file)).with({
        fragment: `L${line}`,
      });
      return `[Open ${file}:${line}](${uri.toString(true)})`;
    },
  );
}

export async function runIndependentReview(
  impactService: ImpactAnalysisService,
  reports: ReportManager,
  token: vscode.CancellationToken,
): Promise<void> {
  const folder = getWorkspaceFolder();
  if (!folder) {
    void vscode.window.showErrorMessage(
      'Open a local folder or workspace before starting an independent review.',
    );
    return;
  }
  if (!hasIndex(folder)) {
    void vscode.window.showWarningMessage(
      'CodeBrain is not initialized for this repository yet. Run “CodeBrain: Initialize Workspace”, then try the review again.',
    );
    return;
  }

  const config = vscode.workspace.getConfiguration('codebrain');
  const maxDiffCharacters = config.get<number>('chat.maxDiffCharacters', 120_000);
  const model = await selectCodeBrainModel();
  if (!model) {
    void vscode.window.showErrorMessage(
      'No AI model is available for the review. Sign in to a model provider or choose another model, then try again.',
    );
    return;
  }

  const analysis = await impactService.analyze(folder, token);
  const gitContext = await collectGitReviewContext(folder.uri.fsPath, maxDiffCharacters);
  const request = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User(reviewPrompt(analysis, gitContext.diff))],
    {},
    token,
  );
  let markdown = '';
  for await (const fragment of request.text) {
    markdown += fragment;
  }
  if (!markdown.trim()) {
    throw new Error('The selected language model returned an empty review.');
  }

  publishInlineFindings(folder, markdown);
  markdown = addFindingLinks(folder, markdown);
  await reports.setLatest(
    {
      kind: 'review',
      title: 'CodeBrain independent review',
      markdown,
      folder,
    },
    true,
  );

  const findingLabel = reviewLocations.length === 1
    ? '1 finding'
    : `${reviewLocations.length} findings`;
  void vscode.window.showInformationMessage(
    `Your CodeBrain review is ready — ${findingLabel} highlighted in the changed files.`,
  );
}
