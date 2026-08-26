import * as vscode from 'vscode';
import { runAffectedTests } from './affectedTests';
import { AtlassianIntegration } from './atlassianSetup';
import { BlastRadiusLensProvider } from './blastRadiusLens';
import { registerChatParticipant } from './chat';
import { CodeBrainMcpRegistration } from './codegraphMcpSetup';
import {
  editCommitTemplate,
  generateCommitMessage,
  selectCommitFormat,
} from './commitMessage';
import { GraphCache } from './graphCache';
import { ImpactController } from './impactController';
import { IndexFreshness } from './indexFreshness';
import {
  ReviewCodeActionProvider,
  ReviewPresenter,
  runIndependentReview,
} from './independentReview';
import { chooseCodeBrainModel } from './modelSelection';
import { IndexManager } from './indexManager';
import { MetricsStore } from './metrics';
import { registerMcpProvider, validateBundledRuntime } from './mcpProvider';
import { ReportManager } from './reportManager';
import { showReleaseNotes, showReleaseNotesOnUpdate } from './releaseNotes';
import { ReviewFinding, ReviewStore } from './reviewStore';
import { editReviewInstructions, selectReviewProfile } from './reviewInstructions';

export function activate(context: vscode.ExtensionContext): void {
  try {
    const runtime = validateBundledRuntime(context);

    const atlassian = new AtlassianIntegration(context, runtime);
    context.subscriptions.push(atlassian);
    registerMcpProvider(context, runtime, atlassian);
    // An extension update moves the bundled server's path, which breaks the
    // entry every already-registered agent holds. Repair those in the
    // background rather than making the user re-run the register command.
    atlassian.refreshInstalledTargets();

    const metrics = new MetricsStore(context);
    const reports = new ReportManager(context);
    const reviewStore = new ReviewStore(context);
    const exploreCache = new GraphCache<string>();

    // Created before the index manager so its logger can be handed over.
    let logSink: (message: string) => void = () => {};
    const freshness = new IndexFreshness(runtime, (message) => logSink(message));
    const indexManager = new IndexManager(runtime, context, freshness);
    logSink = (message) => indexManager.log(message);

    // Copilot gets the code graph server from the definition provider above
    // and the skill from `contributes.chatSkills`; Claude Code, Codex, Gemini
    // CLI and Antigravity read their own files, so they get both (opt-in)
    // through this.
    const codeBrainMcp = new CodeBrainMcpRegistration(
      runtime,
      context.extensionUri.fsPath,
      (message) => logSink(message),
    );
    codeBrainMcp.refreshInstalledTargets();

    // Silent by design — the runtime is usable again — but worth a trace so a
    // host that keeps dropping unix file modes is visible when someone looks.
    if (runtime.repairedExecutables.length > 0) {
      indexManager.log(
        `[runtime] restored the execute bit on ${runtime.repairedExecutables.join(', ')}`,
      );
    }

    const impactController = new ImpactController(
      context,
      runtime,
      metrics,
      reports,
      freshness,
      exploreCache,
    );
    const presenter = new ReviewPresenter(context.extensionUri, reviewStore);
    const lensProvider = new BlastRadiusLensProvider(runtime, freshness, logSink);

    context.subscriptions.push(
      freshness,
      indexManager,
      presenter,
      lensProvider,
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lensProvider),
      vscode.languages.registerCodeActionsProvider(
        { scheme: 'file' },
        new ReviewCodeActionProvider(presenter),
        { providedCodeActionKinds: ReviewCodeActionProvider.kinds },
      ),
      vscode.commands.registerCommand('codebrain.reviewChanges', () =>
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'CodeBrain: Reviewing your changes…',
            cancellable: true,
          },
          (_progress, token) =>
            runIndependentReview(
              impactController.analysisService,
              reports,
              presenter,
              token,
            ),
        ),
      ),
      vscode.commands.registerCommand('codebrain.selectModel', () =>
        chooseCodeBrainModel(),
      ),
      // Invoked from the Source Control title bar, which passes the
      // SourceControl the button belongs to — that identifies the repository.
      vscode.commands.registerCommand(
        'codebrain.generateCommitMessage',
        (sourceControl?: unknown) => generateCommitMessage(sourceControl),
      ),
      vscode.commands.registerCommand(
        'codebrain.selectCommitFormat',
        (sourceControl?: unknown) => selectCommitFormat(sourceControl),
      ),
      vscode.commands.registerCommand(
        'codebrain.editCommitTemplate',
        (sourceControl?: unknown) => editCommitTemplate(sourceControl),
      ),
      vscode.commands.registerCommand('codebrain.registerMcp', () =>
        codeBrainMcp.install(),
      ),
      vscode.commands.registerCommand('codebrain.unregisterMcp', () =>
        codeBrainMcp.remove(),
      ),
      vscode.commands.registerCommand('codebrain.configureAtlassian', () =>
        atlassian.configure(),
      ),
      vscode.commands.registerCommand('codebrain.registerAtlassianMcp', () =>
        atlassian.install(),
      ),
      vscode.commands.registerCommand('codebrain.unregisterAtlassianMcp', () =>
        atlassian.remove(),
      ),
      vscode.commands.registerCommand('codebrain.testAtlassianConnection', () =>
        atlassian.testConnection(),
      ),
      vscode.commands.registerCommand('codebrain.clearAtlassianCredentials', () =>
        atlassian.clear(),
      ),
      vscode.commands.registerCommand('codebrain.editReviewInstructions', () =>
        editReviewInstructions(),
      ),
      vscode.commands.registerCommand('codebrain.selectReviewProfile', () =>
        selectReviewProfile(),
      ),
      vscode.commands.registerCommand('codebrain.nextReviewFinding', () =>
        presenter.navigate(1),
      ),
      vscode.commands.registerCommand('codebrain.previousReviewFinding', () =>
        presenter.navigate(-1),
      ),
      vscode.commands.registerCommand(
        'codebrain.dismissReviewFinding',
        // Invoked from the lightbulb (with a finding) and from the comment
        // thread's title bar (with a CommentThread).
        (argument?: ReviewFinding | vscode.CommentThread) => {
          const finding = presenter.resolveFinding(argument);
          if (!finding) return;
          return presenter.dismiss([finding.id]);
        },
      ),
      vscode.commands.registerCommand(
        'codebrain.dismissFileReviewFindings',
        (argument?: { uri?: string }) => {
          const uri = argument?.uri
            ? vscode.Uri.parse(argument.uri)
            : vscode.window.activeTextEditor?.document.uri;
          if (!uri) return;
          return presenter.dismiss(
            presenter.findingsInFile(uri).map((finding) => finding.id),
          );
        },
      ),
      vscode.commands.registerCommand('codebrain.restoreDismissedFindings', () =>
        presenter.restoreDismissed(),
      ),
      vscode.commands.registerCommand(
        'codebrain.explainReviewFinding',
        async (finding?: ReviewFinding) => {
          if (!finding) return;
          await openChatWith(
            `@codebrain /explain This CodeBrain review finding was reported on ${finding.file}:${finding.line} (${finding.severity}). Explain the workflow behind it and whether it is a real problem.\n\n${finding.body}`,
          );
        },
      ),
      vscode.commands.registerCommand(
        'codebrain.replyToFinding',
        async (reply?: vscode.CommentReply) => {
          if (!reply?.text?.trim()) return;
          const finding = presenter.resolveFinding(reply.thread);
          reply.thread.comments = [
            ...reply.thread.comments,
            {
              body: new vscode.MarkdownString(reply.text),
              mode: vscode.CommentMode.Preview,
              author: { name: 'You' },
            },
          ];
          await openChatWith(
            finding
              ? `@codebrain /review About the CodeBrain finding on ${finding.file}:${finding.line} (${finding.severity}):\n\n${finding.body}\n\nMy question: ${reply.text}`
              : `@codebrain /review ${reply.text}`,
          );
        },
      ),
      vscode.commands.registerCommand(
        'codebrain.runAffectedTests',
        (argument?: { root: string; tests: string[] }) =>
          runAffectedTests(argument, () => impactController.latestTestTarget()),
      ),
      vscode.commands.registerCommand('codebrain.showReleaseNotes', () =>
        showReleaseNotes(context, { log: logSink }),
      ),
    );

    registerChatParticipant(
      context,
      runtime,
      indexManager,
      impactController,
      metrics,
      reports,
      freshness,
      exploreCache,
      logSink,
    );

    // Bring back the findings from the last session's review.
    void presenter.restore();

    // An update lands silently, so the user never learns what they just got.
    // Deliberately last and unawaited: it is the least urgent thing here, and
    // it must never delay or break activation.
    void showReleaseNotesOnUpdate(context, logSink);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`CodeBrain extension: ${message}`);
  }
}

/**
 * Open the chat view with a prefilled prompt. Best-effort: the command id
 * differs across VS Code versions, so a failure falls back to the clipboard
 * rather than showing an error the developer cannot act on.
 */
async function openChatWith(query: string): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', { query });
  } catch {
    await vscode.env.clipboard.writeText(query);
    void vscode.window.showInformationMessage(
      'CodeBrain copied the question to your clipboard — paste it into Chat.',
    );
  }
}

export function deactivate(): void {
  // Disposables registered in the extension context stop providers and UI.
}
