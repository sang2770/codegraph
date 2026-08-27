/**
 * The board's two surfaces and the commands around them.
 *
 * Both surfaces — the sidebar {@link JiraBoardViewProvider} and the full
 * {@link JiraBoardPanel} — are thin: they own a webview, push the service's
 * composed view into it, and route messages back out to {@link handleMessage}.
 * Neither holds board state of its own, so the two are never out of sync and a
 * reloaded webview needs no recovery logic.
 */

import * as vscode from 'vscode';
import { AtlassianIntegration } from '../atlassianSetup';
import {
  askAboutIssue,
  checkoutForIssue,
  copyIssueKey,
  fetchBranches,
  moveIssueToCategory,
  openIssue,
  pickProjectKeys,
  transitionIssue,
  TransitionOutcome,
} from './actions';
import { boardHtml } from './boardHtml';
import { BoardIssue, STATUS_CATEGORIES } from './model';
import { BoardView, JiraBoardService, readBoardConfig } from './service';

export const JIRA_BOARD_VIEW_ID = 'codebrain.jiraBoard';

/** Messages the webview can send. Anything else is ignored. */
interface BoardMessage {
  command?: string;
  key?: string;
  filters?: unknown;
  /** Target column for a drop, validated against {@link STATUS_CATEGORIES}. */
  category?: string;
}

/**
 * Apply a successful transition to the board.
 *
 * The card moves immediately from what Jira reported the new status to be, then
 * a real reload follows — a workflow with post-functions can leave the issue
 * somewhere other than the destination status implied, and the reload is what
 * corrects the optimistic move.
 */
async function afterTransition(
  service: JiraBoardService,
  key: string,
  outcome: TransitionOutcome,
): Promise<void> {
  if (!outcome.ok) return;
  if (outcome.status) service.applyLocalStatus(key, outcome.status, outcome.category);
  await service.refresh({ reason: 'issue moved' });
}

/**
 * Route one webview message.
 *
 * Every branch resolves the issue from the service's loaded set rather than
 * trusting the key it was handed, so a stale webview cannot act on a ticket the
 * board is no longer showing.
 */
async function handleMessage(
  message: BoardMessage,
  service: JiraBoardService,
  atlassian: AtlassianIntegration,
): Promise<void> {
  const issue = (): BoardIssue | undefined =>
    message.key ? service.issue(message.key) : undefined;

  switch (message.command) {
    case 'ready':
      // The webview just (re)loaded and has nothing on screen. Load if this is
      // the first time; otherwise hand it the state already in memory.
      if (!service.view().data.loadedAt) await service.refresh({ reason: 'view opened' });
      else service.notify();
      return;
    case 'refresh':
      // An explicit refresh is also how a project created since the picker was
      // last opened gets picked up.
      service.invalidateProjects();
      await service.refresh({ reason: 'manual refresh' });
      return;
    case 'setFilters':
      await service.setFilters(message.filters);
      return;
    case 'resetFilters':
      await service.resetFilters();
      return;
    case 'configure':
      await vscode.commands.executeCommand('codebrain.configureAtlassian');
      return;
    case 'testConnection':
      await vscode.commands.executeCommand('codebrain.testAtlassianConnection');
      return;
    case 'openBoard':
      await vscode.commands.executeCommand('codebrain.openJiraBoard');
      return;
    case 'fetch':
      await fetchBranches(service.view().data.repository);
      await service.refreshRepository();
      return;
    case 'openIssue': {
      const target = issue();
      if (target) await openIssue(target);
      return;
    }
    case 'copyKey': {
      const target = issue();
      if (target) await copyIssueKey(target);
      return;
    }
    case 'ask': {
      const target = issue();
      if (target) await askAboutIssue(target);
      return;
    }
    case 'checkout': {
      const target = issue();
      if (!target) return;
      const view = service.view();
      const outcome = await checkoutForIssue(target, view.data.repository, view.config);
      if (outcome?.ok) await service.refreshRepository();
      return;
    }
    case 'transition': {
      const target = issue();
      if (!target) return;
      await afterTransition(service, target.key, await transitionIssue(target, atlassian));
      return;
    }
    case 'moveTo': {
      const target = issue();
      const category = STATUS_CATEGORIES.find((entry) => entry === message.category);
      if (!target || !category) return;
      await afterTransition(
        service,
        target.key,
        await moveIssueToCategory(target, category, atlassian),
      );
      return;
    }
    case 'pickProjects':
      await vscode.commands.executeCommand('codebrain.jiraSelectProjects');
      return;
    default:
      return;
  }
}

/** Open the project picker and apply what came back. */
async function selectProjects(service: JiraBoardService): Promise<void> {
  const view = service.view();
  if (!view.data.configured) {
    const choice = await vscode.window.showWarningMessage(
      'CodeBrain: connect Jira first, then pick the projects to show.',
      'Configure…',
    );
    if (choice === 'Configure…') {
      await vscode.commands.executeCommand('codebrain.configureAtlassian');
    }
    return;
  }

  const projects = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'CodeBrain: reading Jira projects…' },
    () => service.loadProjects(),
  );
  const after = service.view();
  const picked = await pickProjectKeys(
    projects,
    after.selectedProjects,
    after.data.projectsError ? { error: after.data.projectsError } : {},
  );
  if (!picked) return;
  await service.setProjects(picked);
}

/** The board in the sidebar: same data, compact layout, no charts. */
export class JiraBoardViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: JiraBoardService,
    private readonly atlassian: AtlassianIntegration,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = boardHtml(view.webview, this.extensionUri, 'sidebar');
    this.disposables.push(
      view.webview.onDidReceiveMessage((message: BoardMessage) =>
        handleMessage(message, this.service, this.atlassian),
      ),
      view.onDidChangeVisibility(() => {
        if (view.visible) this.service.notify();
      }),
    );
    // The sidebar can be closed and reopened, which resolves the view a second
    // time — the previous round's listeners have to go with the old webview.
    view.onDidDispose(() => {
      this.view = undefined;
      while (this.disposables.length > 0) this.disposables.pop()?.dispose();
    });
  }

  post(state: BoardView): void {
    void this.view?.webview.postMessage({ type: 'state', view: state });
  }
}

/** The full board in an editor tab: charts, wider columns, one at a time. */
export class JiraBoardPanel {
  private static current: JiraBoardPanel | undefined;

  static show(
    extensionUri: vscode.Uri,
    service: JiraBoardService,
    atlassian: AtlassianIntegration,
  ): JiraBoardPanel {
    if (JiraBoardPanel.current) {
      JiraBoardPanel.current.panel.reveal(vscode.ViewColumn.Active);
      JiraBoardPanel.current.post(service.view());
      return JiraBoardPanel.current;
    }
    JiraBoardPanel.current = new JiraBoardPanel(extensionUri, service, atlassian);
    return JiraBoardPanel.current;
  }

  static get instance(): JiraBoardPanel | undefined {
    return JiraBoardPanel.current;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    extensionUri: vscode.Uri,
    private readonly service: JiraBoardService,
    atlassian: AtlassianIntegration,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'codebrain.jiraBoardPanel',
      'Jira Board',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    this.panel.webview.html = boardHtml(this.panel.webview, extensionUri, 'panel');
    this.panel.webview.onDidReceiveMessage(
      (message: BoardMessage) => handleMessage(message, service, atlassian),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible) this.post(this.service.view());
      },
      undefined,
      this.disposables,
    );
  }

  post(state: BoardView): void {
    void this.panel.webview.postMessage({ type: 'state', view: state });
  }

  dispose(): void {
    JiraBoardPanel.current = undefined;
    while (this.disposables.length > 0) this.disposables.pop()?.dispose();
  }
}

/**
 * The current branch's ticket, in the status bar.
 *
 * The one piece of the feature that is useful without opening anything: it puts
 * the ticket behind the branch you are on next to the branch indicator, and
 * goes amber when that ticket is overdue.
 */
class JiraStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.item.command = 'codebrain.openIssueForCurrentBranch';
  }

  update(view: BoardView): void {
    const key = view.data.repository.branchIssueKey;
    if (!readBoardConfig().statusBar || !key) {
      this.item.hide();
      return;
    }
    const card = view.cards.find((entry) => entry.issue.key === key);
    const issue = card?.issue ?? view.data.issues.find((entry) => entry.key === key);
    const overdue = card?.warnings.some((warning) => warning.kind === 'overdue') ?? false;

    this.item.text = `$(issues) ${key}${issue ? ` · ${issue.status}` : ''}`;
    this.item.tooltip = issue
      ? new vscode.MarkdownString(
          `**${issue.key}** — ${issue.summary}\n\n${issue.status} · ${issue.assignee ?? 'Unassigned'}${issue.dueDate ? ` · due ${issue.dueDate}` : ''}\n\nClick to open in Jira.`,
        )
      : new vscode.MarkdownString(
          `**${key}** — read from the branch name. Not in the loaded board; click to open it in Jira.`,
        );
    this.item.backgroundColor = overdue
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

/** Ask which ticket to work on, from the loaded board. */
async function pickIssue(
  service: JiraBoardService,
  placeHolder: string,
): Promise<BoardIssue | undefined> {
  const view = service.view();
  if (!view.data.configured) {
    const choice = await vscode.window.showWarningMessage(
      'CodeBrain: Jira is not configured yet.',
      'Configure…',
    );
    if (choice === 'Configure…') {
      await vscode.commands.executeCommand('codebrain.configureAtlassian');
    }
    return undefined;
  }
  if (view.data.issues.length === 0) await service.refresh({ reason: 'issue picker' });

  const issues = service.view().cards;
  if (issues.length === 0) {
    void vscode.window.showInformationMessage(
      'CodeBrain: no issues on the board to choose from. Widen the filters in the Jira Board view.',
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    issues.map((card) => ({
      label: `${card.onBranch ? '$(git-branch) ' : ''}${card.issue.key} ${card.issue.summary}`,
      description: [card.issue.status, card.issue.dueDate ? `due ${card.issue.dueDate}` : undefined]
        .filter(Boolean)
        .join(' · '),
      detail: card.warnings.map((warning) => warning.label).join(' · ') || undefined,
      issue: card.issue,
    })),
    { placeHolder, matchOnDescription: true, matchOnDetail: true },
  );
  return picked?.issue;
}

/**
 * Wire up the board: one service, two surfaces, the status bar, and the
 * commands that reach them from outside the view.
 */
export function registerJiraBoard(
  context: vscode.ExtensionContext,
  atlassian: AtlassianIntegration,
  log: (message: string) => void,
): JiraBoardService {
  const service = new JiraBoardService(context, atlassian, log);
  const provider = new JiraBoardViewProvider(context.extensionUri, service, atlassian);
  const statusBar = new JiraStatusBar();

  context.subscriptions.push(
    service,
    statusBar,
    vscode.window.registerWebviewViewProvider(JIRA_BOARD_VIEW_ID, provider, {
      // The board keeps filters and scroll position while the view is hidden;
      // reloading it on every sidebar switch would also re-query Jira.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    service.onDidChange((view) => {
      provider.post(view);
      JiraBoardPanel.instance?.post(view);
      statusBar.update(view);
    }),
    vscode.commands.registerCommand('codebrain.openJiraBoard', () => {
      JiraBoardPanel.show(context.extensionUri, service, atlassian);
    }),
    vscode.commands.registerCommand('codebrain.refreshJiraBoard', () => {
      service.invalidateProjects();
      return service.refresh({ reason: 'refresh command' });
    }),
    vscode.commands.registerCommand('codebrain.jiraSelectProjects', () =>
      selectProjects(service),
    ),
    vscode.commands.registerCommand('codebrain.jiraCheckoutBranch', async () => {
      const issue = await pickIssue(service, 'Check out the branch for which ticket?');
      if (!issue) return;
      const view = service.view();
      const outcome = await checkoutForIssue(issue, view.data.repository, view.config);
      if (outcome?.ok) await service.refreshRepository();
    }),
    vscode.commands.registerCommand('codebrain.openIssueForCurrentBranch', async () => {
      const view = service.view();
      const key = view.data.repository.branchIssueKey;
      if (!key) {
        const issue = await pickIssue(service, 'The branch carries no issue key. Open which ticket?');
        if (issue) await openIssue(issue);
        return;
      }
      const issue = service.issue(key);
      if (issue) {
        await openIssue(issue);
        return;
      }
      // The branch names a ticket the current filters did not load — the browse
      // URL is still correct, so open it rather than reporting nothing.
      const baseUrl = view.data.jiraBaseUrl;
      if (!baseUrl) {
        void vscode.window.showWarningMessage(
          `CodeBrain: ${key} is not on the board and Jira is not configured.`,
        );
        return;
      }
      await vscode.env.openExternal(
        vscode.Uri.parse(`${baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}`),
      );
    }),
  );

  // Seed the branch → ticket link without waiting for the view to be opened:
  // the status bar is the part people want passively. The load is skipped
  // entirely when Jira is unconfigured or the current branch names no ticket,
  // so a workspace that does not use this pays no request.
  void (async () => {
    await service.refreshRepository();
    const view = service.view();
    if (view.config.statusBar && view.data.repository.branchIssueKey) {
      await service.refresh({ reason: 'branch ticket in the status bar' });
    }
  })();
  return service;
}
