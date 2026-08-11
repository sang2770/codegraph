import { resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import { collectGitReviewContext } from './gitContext';
import { ImpactAnalysis, ImpactAnalysisService } from './impact';
import { selectCodeBrainModel } from './modelSelection';
import { ReportManager } from './reportManager';
import { customReviewPrompt } from './reviewInstructions';
import { buildReviewContext } from './reviewContext';
import {
  findingId,
  parseReviewFindings,
  resolveAnchor,
  ReviewFinding,
  ReviewStore,
} from './reviewStore';
import { getWorkspaceFolder, hasIndex } from './workspace';

const MAX_REVIEW_EVIDENCE = 100_000;

const SEVERITY_DECORATIONS: ReadonlyArray<[string, string, string]> = [
  ['critical', 'editorError.background', 'editorOverviewRuler.errorForeground'],
  ['high', 'editorError.background', 'editorOverviewRuler.errorForeground'],
  ['medium', 'editorWarning.background', 'editorOverviewRuler.warningForeground'],
  ['low', 'editorInfo.background', 'editorOverviewRuler.infoForeground'],
];

function workspaceRelativeFile(
  folder: vscode.WorkspaceFolder,
  file: string,
  allowedFiles?: Set<string>,
): { path: string; uri: vscode.Uri } | undefined {
  const root = resolve(folder.uri.fsPath);
  const target = resolve(root, file);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    return undefined;
  }
  const path = target.slice(root.length + 1).replaceAll('\\', '/');
  if (allowedFiles && !allowedFiles.has(path)) {
    return undefined;
  }
  return { path, uri: vscode.Uri.file(target) };
}

function conciseFindingBody(body: string): string {
  const text = body.replace(/<!--[^>]*-->/g, '').trim();
  const impact = text.match(
    /(?:impact|consequence|affected workflow)\s*:\s*(.+?)(?=\n\s*(?:\*{0,2}recommendation|\*{0,2}fix|\*{0,2}suggestion)\s*:|$)/is,
  )?.[1]?.trim();
  const recommendation = text
    .match(/(?:recommendation|fix|suggestion)\s*:\s*(.+)$/is)?.[1]
    ?.trim();
  const fallback = text.split(/\n+/).map((line) => line.trim()).find(Boolean) ?? '';
  const lines = [
    `**Impact:** ${impact || fallback || 'The review identified a potential issue on this line.'}`,
  ];
  if (recommendation) lines.push(`**Recommendation:** ${recommendation}`);
  return lines.join('\n\n').slice(0, 2_000);
}

async function documentLines(uri: vscode.Uri): Promise<string[] | undefined> {
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === uri.toString(),
  );
  const document = open ?? (await vscode.workspace.openTextDocument(uri).then(
    (value) => value,
    () => undefined,
  ));
  if (!document) return undefined;
  return Array.from({ length: document.lineCount }, (_, index) =>
    document.lineAt(index).text,
  );
}

interface RenderedFinding {
  finding: ReviewFinding;
  uri: vscode.Uri;
  line: number;
  drifted: boolean;
  lost: boolean;
}

/**
 * Owns every editor surface a review produces: diagnostics, comment threads,
 * line highlights, and navigation.
 *
 * It renders from {@link ReviewStore} rather than from local state, so a review
 * survives a window reload and a dismissed finding stays dismissed.
 */
export class ReviewPresenter implements vscode.Disposable {
  private readonly diagnostics =
    vscode.languages.createDiagnosticCollection('codebrain-review');
  private readonly decorations = new Map<
    string,
    vscode.TextEditorDecorationType
  >();
  private commentController?: vscode.CommentController;
  private threads: vscode.CommentThread[] = [];
  private rendered: RenderedFinding[] = [];
  private cursor = -1;
  /**
   * Renders are serialized through this chain, and superseded ones are dropped.
   *
   * `render` awaits file contents part-way through. Two overlapping calls — a
   * "Save All" firing two save events, or a save landing while `publish` is
   * still rendering — would each clear and then each append a full set of
   * threads, producing duplicate comment threads on every finding and a
   * navigation list that visits each one twice.
   */
  private renderChain: Promise<void> = Promise.resolve();
  private renderRequests = 0;
  private readonly avatar: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    extensionUri: vscode.Uri,
    private readonly store: ReviewStore,
  ) {
    this.avatar = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    for (const [severity, background, ruler] of SEVERITY_DECORATIONS) {
      this.decorations.set(
        severity,
        vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: new vscode.ThemeColor(background),
          overviewRulerColor: new vscode.ThemeColor(ruler),
          overviewRulerLane: vscode.OverviewRulerLane.Right,
        }),
      );
    }
    this.disposables.push(
      this.diagnostics,
      ...this.decorations.values(),
      // Re-anchor after edits so a highlight never drifts onto unrelated code.
      vscode.workspace.onDidSaveTextDocument(() => void this.render()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.paintDecorations()),
    );
  }

  public dispose(): void {
    this.clearThreads();
    this.commentController?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  public get findingCount(): number {
    return this.rendered.length;
  }

  /** Restore the last review's surfaces, e.g. after a window reload. */
  public async restore(): Promise<void> {
    if (this.store.getReview()) {
      await this.render();
    }
  }

  /**
   * Turn a fresh review report into stored, anchored findings.
   *
   * Anchor text is captured now, while the file still matches what the model
   * reviewed, so later edits can be followed instead of guessed at.
   */
  public async publish(
    folder: vscode.WorkspaceFolder,
    markdown: string,
    allowedFiles?: Set<string>,
  ): Promise<{ published: number; suppressed: number }> {
    const parsed = parseReviewFindings(markdown);
    const findings: ReviewFinding[] = [];
    const lineCache = new Map<string, string[] | undefined>();
    let suppressed = 0;

    for (const item of parsed) {
      const file = workspaceRelativeFile(folder, item.file, allowedFiles);
      if (!file) continue;
      const key = file.uri.toString();
      if (!lineCache.has(key)) {
        lineCache.set(key, await documentLines(file.uri));
      }
      const lines = lineCache.get(key);
      const anchorText = lines?.[item.line - 1]?.trim() ?? '';
      const finding: ReviewFinding = {
        ...item,
        file: file.path,
        anchorText,
        id: findingId({
          file: file.path,
          severity: item.severity,
          anchorText,
          body: item.body,
        }),
      };
      if (this.store.isDismissed(finding.id)) {
        suppressed += 1;
        continue;
      }
      findings.push(finding);
    }

    await this.store.setReview({
      root: folder.uri.fsPath,
      generatedAt: new Date().toISOString(),
      findings,
    });
    await this.render();
    return { published: findings.length, suppressed };
  }

  private clearThreads(): void {
    for (const thread of this.threads) {
      thread.dispose();
    }
    this.threads = [];
  }

  /** Rebuild every surface from the store, re-anchoring against current files. */
  public render(): Promise<void> {
    const sequence = ++this.renderRequests;
    this.renderChain = this.renderChain.then(async () => {
      // A newer render was queued while this one waited; its result supersedes
      // ours, so skip the work entirely.
      if (sequence !== this.renderRequests) return;
      await this.renderNow();
    });
    return this.renderChain;
  }

  private async renderNow(): Promise<void> {
    this.diagnostics.clear();
    this.clearThreads();
    this.rendered = [];
    this.cursor = -1;

    const review = this.store.getReview();
    const active = this.store.activeFindings();
    if (!review || active.length === 0) {
      this.paintDecorations();
      await vscode.commands.executeCommand(
        'setContext',
        'codebrain.reviewFindings',
        false,
      );
      return;
    }

    const folder = { uri: vscode.Uri.file(review.root) } as vscode.WorkspaceFolder;
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const lineCache = new Map<string, string[] | undefined>();

    for (const finding of active) {
      const file = workspaceRelativeFile(folder, finding.file);
      if (!file) continue;
      const key = file.uri.toString();
      if (!lineCache.has(key)) {
        lineCache.set(key, await documentLines(file.uri));
      }
      const lines = lineCache.get(key);
      const anchor = lines
        ? resolveAnchor(lines, finding.line, finding.anchorText)
        : { line: finding.line, drifted: false, lost: false };

      const range = new vscode.Range(
        Math.max(0, anchor.line - 1),
        0,
        Math.max(0, anchor.line - 1),
        Number.MAX_SAFE_INTEGER,
      );
      const severity =
        finding.severity === 'critical' || finding.severity === 'high'
          ? vscode.DiagnosticSeverity.Error
          : finding.severity === 'medium'
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Information;
      const prefix = anchor.lost
        ? '[the reviewed line no longer exists — location is approximate] '
        : anchor.drifted
          ? `[moved from line ${finding.line}] `
          : '';
      const diagnostic = new vscode.Diagnostic(
        range,
        `${prefix}${finding.body.trim().slice(0, 1_000) || `CodeBrain ${finding.severity} finding`}`,
        severity,
      );
      diagnostic.source = 'CodeBrain Review';
      // Carried through to the code-action provider so it can offer a dismissal
      // for this exact finding.
      diagnostic.code = { value: finding.id, target: file.uri };

      this.rendered.push({
        finding,
        uri: file.uri,
        line: anchor.line,
        drifted: anchor.drifted,
        lost: anchor.lost,
      });
      this.publishThread(file.uri, range, finding, prefix);
      const existing = byFile.get(key) ?? [];
      existing.push(diagnostic);
      byFile.set(key, existing);
    }

    for (const [uri, diagnostics] of byFile) {
      this.diagnostics.set(vscode.Uri.parse(uri), diagnostics);
    }
    this.cursor = this.rendered.length > 0 ? 0 : -1;
    this.paintDecorations();
    await vscode.commands.executeCommand(
      'setContext',
      'codebrain.reviewFindings',
      this.rendered.length > 0,
    );
  }

  private publishThread(
    uri: vscode.Uri,
    range: vscode.Range,
    finding: ReviewFinding,
    prefix: string,
  ): void {
    this.commentController ??= vscode.comments.createCommentController(
      'codebrain-review',
      'CodeBrain Review',
    );
    const body = new vscode.MarkdownString(
      `**${finding.severity.toUpperCase()}** · \`${finding.file}\`\n\n${prefix}${conciseFindingBody(finding.body)}`,
    );
    const thread = this.commentController.createCommentThread(uri, range, [
      {
        body,
        mode: vscode.CommentMode.Preview,
        author: { name: 'CodeBrain Review', iconPath: this.avatar },
      },
    ]);
    // Replies are the channel for disagreeing with a finding. A reviewer that
    // cannot be answered gets muted the third time it is wrong.
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.label = 'CodeBrain Review';
    thread.contextValue = 'codebrainReview';
    this.threads.push(thread);
  }

  private paintDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      for (const [severity, decoration] of this.decorations) {
        const ranges = this.rendered
          .filter(
            (item) =>
              item.uri.toString() === editor.document.uri.toString() &&
              item.finding.severity === severity,
          )
          .map((item) => new vscode.Range(item.line - 1, 0, item.line - 1, 0));
        editor.setDecorations(decoration, ranges);
      }
    }
  }

  public navigate(direction: 1 | -1): void {
    if (this.rendered.length === 0) {
      void vscode.window.showInformationMessage(
        'There are no active CodeBrain findings to navigate. Run “CodeBrain: Review Changes” first.',
      );
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const currentIndex = editor
      ? this.rendered.findIndex(
          (item) =>
            item.uri.toString() === editor.document.uri.toString() &&
            item.line - 1 === editor.selection.active.line,
        )
      : -1;
    const base = currentIndex >= 0 ? currentIndex : this.cursor;
    const index = (base + direction + this.rendered.length) % this.rendered.length;
    const target = this.rendered[index];
    if (!target) return;
    this.cursor = index;
    const range = new vscode.Range(target.line - 1, 0, target.line - 1, 0);
    void vscode.window
      .showTextDocument(target.uri, {
        selection: range,
        viewColumn: vscode.ViewColumn.Active,
      })
      .then(() => this.paintDecorations());
  }

  /**
   * Resolve whatever a command handler was handed into a finding.
   *
   * Commands contributed to a comment thread's title menu receive the
   * `CommentThread`, while code actions pass the finding itself. Accepting both
   * keeps the dismiss button working from either surface.
   */
  public resolveFinding(
    argument: ReviewFinding | vscode.CommentThread | undefined,
  ): ReviewFinding | undefined {
    if (!argument) return undefined;
    if ('id' in argument && typeof argument.id === 'string') {
      return argument;
    }
    const thread = argument as vscode.CommentThread;
    const line = thread.range?.start.line;
    if (!thread.uri || line === undefined) return undefined;
    return this.findingAt(thread.uri, line);
  }

  /** The finding at a document position, for the code-action provider. */
  public findingAt(uri: vscode.Uri, line: number): ReviewFinding | undefined {
    return this.rendered.find(
      (item) => item.uri.toString() === uri.toString() && item.line - 1 === line,
    )?.finding;
  }

  public findingsInFile(uri: vscode.Uri): ReviewFinding[] {
    return this.rendered
      .filter((item) => item.uri.toString() === uri.toString())
      .map((item) => item.finding);
  }

  public async dismiss(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.store.dismiss(ids);
    await this.render();
    void vscode.window.showInformationMessage(
      ids.length === 1
        ? 'CodeBrain finding dismissed. It will stay hidden in future reviews too.'
        : `${ids.length} CodeBrain findings dismissed. They will stay hidden in future reviews too.`,
    );
  }

  public async restoreDismissed(): Promise<void> {
    const count = await this.store.restoreAll();
    await this.render();
    void vscode.window.showInformationMessage(
      count === 0
        ? 'There were no dismissed CodeBrain findings to restore.'
        : `Restored ${count} dismissed CodeBrain finding(s).`,
    );
  }
}

/**
 * Offers per-finding actions on the diagnostic itself, where the developer is
 * already looking, instead of only in the command palette.
 */
export class ReviewCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly kinds = [vscode.CodeActionKind.QuickFix];

  public constructor(private readonly presenter: ReviewPresenter) {}

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const ours = context.diagnostics.filter(
      (diagnostic) => diagnostic.source === 'CodeBrain Review',
    );
    if (ours.length === 0) {
      return [];
    }
    const finding = this.presenter.findingAt(document.uri, range.start.line);
    const actions: vscode.CodeAction[] = [];

    if (finding) {
      const explain = new vscode.CodeAction(
        'CodeBrain: explain this finding',
        vscode.CodeActionKind.QuickFix,
      );
      explain.command = {
        command: 'codebrain.explainReviewFinding',
        title: 'Explain this finding',
        arguments: [finding],
      };
      explain.diagnostics = ours;
      actions.push(explain);

      const dismiss = new vscode.CodeAction(
        'CodeBrain: dismiss this finding (false positive)',
        vscode.CodeActionKind.QuickFix,
      );
      dismiss.command = {
        command: 'codebrain.dismissReviewFinding',
        title: 'Dismiss this finding',
        arguments: [finding],
      };
      dismiss.diagnostics = ours;
      actions.push(dismiss);
    }

    const inFile = this.presenter.findingsInFile(document.uri);
    if (inFile.length > 1) {
      const dismissAll = new vscode.CodeAction(
        `CodeBrain: dismiss all ${inFile.length} findings in this file`,
        vscode.CodeActionKind.QuickFix,
      );
      dismissAll.command = {
        command: 'codebrain.dismissFileReviewFindings',
        title: 'Dismiss all findings in this file',
        arguments: [{ uri: document.uri.toString() }],
      };
      actions.push(dismissAll);
    }
    return actions;
  }
}

function reviewPrompt(
  analysis: ImpactAnalysis,
  diff: string,
  diffTruncated: boolean,
  folder: vscode.WorkspaceFolder,
): string {
  const signals = analysis.assessment.signals
    .map(
      (signal) =>
        `- ${signal.label}: ${signal.score}/${signal.maxScore} — ${signal.detail}`,
    )
    .join('\n');
  const reviewContext = buildReviewContext(
    analysis,
    diff,
    diffTruncated,
    MAX_REVIEW_EVIDENCE,
  );
  const truncationWarning =
    analysis.depthTruncated === true
      ? `\n\nImportant: the dependency traversal stopped at its depth limit of ${analysis.depthLimit}, so the dependent counts in the evidence are lower bounds. Do not describe the blast radius as complete.`
      : '';
  return customReviewPrompt(
    `You are CodeBrain Review, an independent code review engine. Review the current Git changes using both the diff and the semantic graph evidence below.

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

${reviewContext}

Treat the Git diff as the source of truth for what changed. Treat graph evidence as supporting context. Only report a finding when the diff and surrounding source provide concrete evidence. Findings must point to a changed file and a relevant changed line; do not report speculative style preferences, hypothetical issues, or findings based only on file names. Be explicit about uncertainty.${diffTruncated ? '\n\nImportant: The Git diff was truncated before it reached the model. Lower confidence, avoid claiming the full change was reviewed, and call this out in the review limits.' : ''}${truncationWarning}`,
    folder,
  );
}

function addFindingLinks(
  folder: vscode.WorkspaceFolder,
  markdown: string,
  allowedFiles?: Set<string>,
): string {
  return markdown.replace(
    /<!--\s*codebrain-finding\s+severity="(?:critical|high|medium|low)"\s+file="([^"]+)"\s+line="(\d+)"\s*-->/gi,
    (marker, file: string, line: string) => {
      const target = workspaceRelativeFile(folder, file, allowedFiles);
      if (!target) return marker;
      const uri = target.uri.with({ fragment: `L${line}` });
      return `[Open ${file}:${line}](${uri.toString(true)})`;
    },
  );
}

export async function runIndependentReview(
  impactService: ImpactAnalysisService,
  reports: ReportManager,
  presenter: ReviewPresenter,
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
  const gitContext = await collectGitReviewContext(
    folder.uri.fsPath,
    maxDiffCharacters,
  );
  const request = await model.sendRequest(
    [
      vscode.LanguageModelChatMessage.User(
        reviewPrompt(analysis, gitContext.diff, gitContext.truncated, folder),
      ),
    ],
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

  const changedFiles = new Set(
    analysis.changedFiles.map((file) => file.replaceAll('\\', '/')),
  );
  const { published, suppressed } = await presenter.publish(
    folder,
    markdown,
    changedFiles,
  );
  markdown = addFindingLinks(folder, markdown, changedFiles);
  await reports.setLatest(
    {
      kind: 'review',
      title: 'CodeBrain independent review',
      markdown,
      folder,
    },
    true,
  );

  const findingLabel = published === 1 ? '1 finding' : `${published} findings`;
  const suppressedNote =
    suppressed > 0
      ? ` ${suppressed} previously dismissed finding(s) were hidden.`
      : '';
  void vscode.window.showInformationMessage(
    `Your CodeBrain review is ready — ${findingLabel} highlighted in the changed files.${suppressedNote}`,
  );
}
