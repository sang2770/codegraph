/**
 * Board state: what is loaded from Jira, what Git says about the repository it
 * is being viewed next to, and how the two are joined.
 *
 * The service owns loading and caching; it renders nothing and prompts for
 * nothing. Everything the two webviews draw comes out of {@link composeView},
 * which is a pure function of the loaded set plus the filters — so re-filtering
 * and re-sorting never costs a round-trip, and only the filters that change the
 * JQL ({@link needsRefetch}) do.
 */

import * as vscode from 'vscode';
import { AtlassianClient, JiraUser } from '../atlassian/client';
import { AtlassianIntegration } from '../atlassianSetup';
import { getWorkspaceFolder } from '../workspace';
import {
  BranchInfo,
  extractIssueKey,
  isGitRepository,
  listBranches,
} from './branches';
import {
  applyFilters,
  BoardFilters,
  BoardIssue,
  BoardProject,
  BOARD_FIELDS,
  BoardStats,
  buildJql,
  computeStats,
  DEFAULT_FILTERS,
  describeFilters,
  IssueWarning,
  issueWarnings,
  needsRefetch,
  normalizeFilters,
  normalizeIssue,
  normalizeProjects,
  parseProjectKeys,
  StatusCategory,
  statusCategoryOf,
  WarningOptions,
} from './model';

const FILTERS_STATE_KEY = 'codebrain.jira.filters';

/** Tunables the board reads from settings. */
export interface BoardConfig {
  maxIssues: number;
  autoRefreshMinutes: number;
  warnings: WarningOptions;
  branchTemplate: string;
  /** Advanced: a JQL body that replaces every generated condition. */
  jql: string;
  defaultProject: string;
  statusBar: boolean;
  /** Branch a new issue branch is created from. Empty means current HEAD. */
  baseBranch: string;
  /**
   * Whether the board may change Jira. Read from the same setting that governs
   * agents (`codebrain.atlassian.allowWrite`) so there is one answer, not two.
   */
  allowWrite: boolean;
}

export function readBoardConfig(): BoardConfig {
  const config = vscode.workspace.getConfiguration('codebrain.jira');
  return {
    allowWrite:
      vscode.workspace
        .getConfiguration('codebrain.atlassian')
        .get<boolean>('allowWrite', false) === true,
    maxIssues: config.get<number>('maxIssues', 100),
    autoRefreshMinutes: config.get<number>('autoRefreshMinutes', 10),
    warnings: {
      dueSoonDays: config.get<number>('dueSoonDays', 3),
      staleDays: config.get<number>('staleDays', 5),
    },
    branchTemplate: config.get<string>('branchTemplate', '') || '{prefix}/{key}-{summary}',
    jql: config.get<string>('jql', ''),
    defaultProject: config.get<string>('defaultProject', ''),
    statusBar: config.get<boolean>('statusBar', true),
    baseBranch: config.get<string>('baseBranch', ''),
  };
}

/** Git state for the project the board is being viewed next to. */
export interface RepositoryState {
  root?: string;
  isRepository: boolean;
  branch?: string;
  /** Issue key read out of the current branch name, if it carries one. */
  branchIssueKey?: string;
  branches: BranchInfo[];
}

/** Everything one load produced. Cached, and re-filtered without refetching. */
export interface BoardData {
  configured: boolean;
  jiraBaseUrl?: string;
  me?: string;
  issues: BoardIssue[];
  loadedAt?: number;
  loading: boolean;
  /** Total the server reported, which may exceed what was returned. */
  total?: number;
  /** True when the server had more issues than `maxIssues` allowed. */
  capped: boolean;
  jql: string;
  error?: string;
  repository: RepositoryState;
  /** Every project the token may browse. Loaded lazily; empty until then. */
  projects: BoardProject[];
  projectsLoading: boolean;
  /** Why the project list could not be read, when it could not be. */
  projectsError?: string;
}

/** One issue as the board draws it: the issue plus everything derived. */
export interface BoardCard {
  issue: BoardIssue;
  warnings: IssueWarning[];
  /** Local or remote branches whose name carries this issue's key. */
  branches: BranchInfo[];
  /** True when one of those branches is the checked-out one. */
  onBranch: boolean;
}

/** The complete input to a render. Pure product of data + filters. */
export interface BoardView {
  data: BoardData;
  filters: BoardFilters;
  /** Filtered, sorted cards. */
  cards: BoardCard[];
  /** Statistics over the filtered set. */
  stats: BoardStats;
  /** Statistics over everything loaded, for the "of N loaded" context. */
  loadedStats: BoardStats;
  /** Every distinct status in the loaded set, for the status chips. */
  statuses: string[];
  /** The project keys currently filtered on, parsed out of the filter text. */
  selectedProjects: string[];
  summary: string;
  now: number;
  config: BoardConfig;
}

/** Project keys present in a loaded set, used to validate a branch's key. */
export function projectKeysOf(issues: readonly BoardIssue[]): string[] {
  const keys = new Set<string>();
  for (const issue of issues) {
    const project = issue.key.split('-')[0];
    if (project) keys.add(project.toUpperCase());
  }
  return [...keys];
}

/**
 * Join loaded issues, filters and Git state into one renderable view.
 *
 * Pure and exported so the rendering can be tested, and so both the sidebar and
 * the full board are guaranteed to agree about what "overdue" means.
 */
export function composeView(
  data: BoardData,
  filters: BoardFilters,
  config: BoardConfig,
  now: Date,
): BoardView {
  const visible = applyFilters(data.issues, filters, now, config.warnings);
  const branchesByKey = new Map<string, BranchInfo[]>();
  for (const branch of data.repository.branches) {
    if (!branch.issueKey) continue;
    const existing = branchesByKey.get(branch.issueKey);
    if (existing) existing.push(branch);
    else branchesByKey.set(branch.issueKey, [branch]);
  }

  const cards: BoardCard[] = visible.map((issue) => {
    const branches = branchesByKey.get(issue.key.toUpperCase()) ?? [];
    return {
      issue,
      warnings: issueWarnings(issue, now, config.warnings),
      branches,
      onBranch: branches.some((branch) => branch.isCurrent),
    };
  });

  const statuses = [...new Set(data.issues.map((issue) => issue.status))].sort((left, right) =>
    left.localeCompare(right),
  );

  return {
    data,
    filters,
    cards,
    stats: computeStats(visible, now, config.warnings),
    loadedStats: computeStats(data.issues, now, config.warnings),
    statuses,
    selectedProjects: parseProjectKeys(filters.projects),
    summary: describeFilters(filters),
    now: now.getTime(),
    config,
  };
}

export class JiraBoardService implements vscode.Disposable {
  private readonly didChange = new vscode.EventEmitter<BoardView>();
  private readonly disposables: vscode.Disposable[] = [];

  private currentFilters: BoardFilters;
  private data: BoardData = {
    configured: false,
    issues: [],
    loading: false,
    capped: false,
    jql: '',
    repository: { isRepository: false, branches: [] },
    projects: [],
    projectsLoading: false,
  };
  private me: JiraUser | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private headWatcher: vscode.FileSystemWatcher | undefined;
  private inFlight: Promise<void> | undefined;
  private projectsInFlight: Promise<BoardProject[]> | undefined;
  /** True when the project list hit the client's own cap — reported, not hidden. */
  private projectListTruncated = false;

  /** Fires with a freshly composed view whenever anything changed. */
  readonly onDidChange = this.didChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly atlassian: AtlassianIntegration,
    private readonly log: (message: string) => void,
  ) {
    const stored = context.workspaceState.get<unknown>(FILTERS_STATE_KEY);
    this.currentFilters = normalizeFilters(stored ?? DEFAULT_FILTERS);
    if (!this.currentFilters.projects.trim()) {
      this.currentFilters.projects = readBoardConfig().defaultProject;
    }

    this.disposables.push(
      this.didChange,
      // Credentials or URLs changed: the next load has to use them, and the
      // "connect Jira" call-to-action has to disappear on its own.
      this.atlassian.onDidChange(() => {
        this.me = undefined;
        // The project list belongs to the old credentials — another site has
        // other projects, and a stale picker would offer keys that match
        // nothing.
        this.data = { ...this.data, projects: [], projectsLoading: false };
        this.projectsInFlight = undefined;
        void this.refresh({ reason: 'credentials changed' });
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('codebrain.jira')) return;
        this.scheduleAutoRefresh();
        void this.refresh({ reason: 'settings changed' });
      }),
      // A checkout done in a terminal or by the Git view has to move the
      // board's "you are on this ticket" banner too.
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) void this.refreshRepository();
      }),
    );

    this.scheduleAutoRefresh();
    this.watchHead();
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.headWatcher?.dispose();
    for (const disposable of this.disposables.reverse()) disposable.dispose();
  }

  // ------------------------------------------------------------------ state

  get filters(): BoardFilters {
    return this.currentFilters;
  }

  /** The current view, composed on demand so `now` is never stale. */
  view(): BoardView {
    return composeView(this.data, this.currentFilters, readBoardConfig(), new Date());
  }

  private emit(): void {
    this.didChange.fire(this.view());
  }

  /**
   * Re-send the current state without reloading.
   *
   * A webview that was just created, or one that became visible again, has an
   * empty document but the service still holds everything it needs.
   */
  notify(): void {
    this.emit();
  }

  /**
   * Apply a filter change: persisted, then either refetched or re-rendered
   * from the loaded set depending on whether the JQL actually changed.
   */
  async setFilters(next: unknown): Promise<void> {
    const previous = this.currentFilters;
    const merged = normalizeFilters({ ...previous, ...(next as object) });
    this.currentFilters = merged;
    await this.context.workspaceState.update(FILTERS_STATE_KEY, merged);
    if (needsRefetch(previous, merged)) {
      await this.refresh({ reason: 'filters changed' });
      return;
    }
    this.emit();
  }

  async resetFilters(): Promise<void> {
    await this.setFilters({
      ...DEFAULT_FILTERS,
      projects: readBoardConfig().defaultProject,
      warning: undefined,
    });
  }

  /** Replace the project selection with an exact set of keys. */
  async setProjects(keys: readonly string[]): Promise<void> {
    await this.setFilters({ projects: keys.join(', ') });
  }

  // ---------------------------------------------------------------- projects

  /**
   * The projects the token may browse, loaded once and reused.
   *
   * Lazy on purpose: a board filtered to one project never needs the list, and
   * on a large Cloud tenant reading it costs several requests. Concurrent
   * callers — the picker opened twice, or the picker and a refresh — share one
   * request the same way {@link refresh} does.
   */
  async loadProjects(options: { force?: boolean } = {}): Promise<BoardProject[]> {
    if (!options.force && this.data.projects.length > 0) return this.data.projects;
    if (this.projectsInFlight) return this.projectsInFlight;

    this.projectsInFlight = (async (): Promise<BoardProject[]> => {
      const { connections } = await this.atlassian.status();
      if (!connections.jira) return [];

      this.data = { ...this.data, projectsLoading: true, projectsError: undefined };
      this.emit();
      try {
        const client = new AtlassianClient({ connections });
        // The recent list is a nicety and a second request, so it never decides
        // whether the picker opens: a failure there leaves the list unsorted.
        const [listed, recent] = await Promise.all([
          client.jiraProjects(),
          client.jiraRecentProjects().catch(() => []),
        ]);
        const projects = normalizeProjects(
          listed.projects,
          recent.map((entry) => entry.key ?? ''),
        );
        this.projectListTruncated = listed.truncated;
        this.data = { ...this.data, projects, projectsLoading: false };
        this.log(
          `[jira] loaded ${projects.length} project(s)${listed.truncated ? ' (list truncated by the client limit)' : ''}`,
        );
        this.emit();
        return projects;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Not fatal: the free-text box still accepts keys typed by hand, so the
        // failure is reported next to the picker rather than as an error dialog.
        this.data = { ...this.data, projectsLoading: false, projectsError: message };
        this.log(`[jira] could not load projects — ${message}`);
        this.emit();
        return [];
      } finally {
        this.projectsInFlight = undefined;
      }
    })();
    return this.projectsInFlight;
  }

  /** What is loaded of the project list right now, without asking Jira. */
  projects(): BoardProject[] {
    return this.data.projects;
  }

  /** Whether the loaded project list is known to be incomplete. */
  projectsTruncated(): boolean {
    return this.projectListTruncated;
  }

  /**
   * Forget the cached project list.
   *
   * Called from an explicit refresh, so a project created since the picker was
   * last opened shows up without restarting the window — and only then, since
   * re-reading it on every automatic refresh would cost several requests for a
   * list that almost never changes.
   */
  invalidateProjects(): void {
    this.projectListTruncated = false;
    if (this.data.projects.length === 0 && !this.data.projectsError) return;
    this.data = { ...this.data, projects: [], projectsError: undefined };
  }

  /** The display name for a key, when the list happens to be loaded. */
  projectName(key: string): string | undefined {
    const wanted = key.toUpperCase();
    return this.data.projects.find((project) => project.key === wanted)?.name;
  }

  // -------------------------------------------------------------- local edits

  /**
   * Move one loaded issue to a new status without refetching.
   *
   * A transition takes a round-trip and a full reload takes another, so the
   * card would sit in its old column for a second or two after the drop — long
   * enough to read as "the drag did nothing" and be repeated. The patch is
   * always followed by a real refresh, which is what corrects it if Jira's
   * workflow did something other than what the destination status implied.
   */
  applyLocalStatus(key: string, status: string, category?: StatusCategory): void {
    const wanted = key.toUpperCase();
    // The transition's destination knows its own category; only a transition
    // that came back without one falls back to reading the status name.
    const resolved: StatusCategory = category ?? statusCategoryOf({ name: status });
    let changed = false;
    const issues = this.data.issues.map((issue) => {
      if (issue.key.toUpperCase() !== wanted) return issue;
      if (issue.status === status && issue.category === resolved) return issue;
      changed = true;
      return { ...issue, status, category: resolved, resolved: resolved === 'done' };
    });
    if (!changed) return;
    this.data = { ...this.data, issues };
    this.emit();
  }

  // ----------------------------------------------------------------- loading

  /**
   * Reload the board.
   *
   * Concurrent calls share one request — the sidebar and the panel both ask on
   * open, and a filter change can land while a load is still running.
   */
  async refresh(options: { reason?: string } = {}): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.load(options.reason).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async load(reason?: string): Promise<void> {
    const config = readBoardConfig();
    this.data = { ...this.data, loading: true, error: undefined };
    this.emit();

    const repository = await this.readRepository();
    const { connections } = await this.atlassian.status();

    if (!connections.jira) {
      this.data = {
        configured: false,
        issues: [],
        loading: false,
        capped: false,
        jql: '',
        repository,
        projects: [],
        projectsLoading: false,
      };
      this.emit();
      return;
    }

    const jql = buildJql(this.currentFilters, config.jql);
    const client = new AtlassianClient({ connections });
    const baseUrl = connections.jira.baseUrl;

    try {
      if (!this.me) {
        // Best-effort: "assigned to me" is a server-side clause that works
        // without it; the identity is only needed to mark cards as yours.
        this.me = await client.jiraWhoAmI().catch(() => undefined);
      }
      const response = await client.jiraSearch({
        jql,
        limit: Math.max(1, Math.min(500, config.maxIssues)),
        fields: BOARD_FIELDS,
      });
      const issues = (response.issues ?? []).map((issue) =>
        normalizeIssue(issue, baseUrl, this.me),
      );

      this.data = {
        configured: true,
        jiraBaseUrl: baseUrl,
        issues,
        loading: false,
        loadedAt: Date.now(),
        projects: this.data.projects,
        projectsLoading: this.data.projectsLoading,
        ...(this.data.projectsError ? { projectsError: this.data.projectsError } : {}),
        capped:
          typeof response.total === 'number'
            ? response.total > issues.length
            : issues.length >= config.maxIssues,
        jql,
        repository: this.withBranchKey(repository, issues),
        ...(typeof response.total === 'number' ? { total: response.total } : {}),
        ...(this.me?.displayName ? { me: this.me.displayName } : {}),
      };
      this.log(
        `[jira] loaded ${issues.length} issue(s)${reason ? ` (${reason})` : ''} — ${jql}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.data = {
        configured: true,
        jiraBaseUrl: baseUrl,
        // The previous set is kept on screen: a transient VPN drop should not
        // wipe a board the user is working from.
        issues: this.data.issues,
        loading: false,
        capped: this.data.capped,
        jql,
        error: message,
        repository,
        projects: this.data.projects,
        projectsLoading: this.data.projectsLoading,
        ...(this.data.projectsError ? { projectsError: this.data.projectsError } : {}),
        ...(this.data.loadedAt ? { loadedAt: this.data.loadedAt } : {}),
      };
      this.log(`[jira] load failed — ${message}`);
    }

    this.emit();
  }

  /** Re-read Git state only. Cheap enough to run on every window focus. */
  async refreshRepository(): Promise<void> {
    const repository = this.withBranchKey(await this.readRepository(), this.data.issues);
    const before = this.data.repository;
    const unchanged =
      before.branch === repository.branch &&
      before.root === repository.root &&
      before.branches.length === repository.branches.length &&
      before.branches.every((branch, index) => branch.name === repository.branches[index]?.name);
    this.data = { ...this.data, repository };
    if (!unchanged) this.emit();
  }

  private async readRepository(): Promise<RepositoryState> {
    const folder = getWorkspaceFolder();
    if (!folder) return { isRepository: false, branches: [] };
    const root = folder.uri.fsPath;
    if (!(await isGitRepository(root))) {
      return { root, isRepository: false, branches: [] };
    }
    const branches = await listBranches(root);
    const current = branches.find((branch) => branch.isCurrent);
    return {
      root,
      isRepository: true,
      branches,
      ...(current ? { branch: current.name } : {}),
    };
  }

  /**
   * Resolve the current branch's issue key against the loaded project keys, so
   * a branch like `chore/node-22` is not reported as ticket NODE-22. With
   * nothing loaded yet the syntactic match is used — it is better than showing
   * no ticket at all, and the next load narrows it.
   */
  private withBranchKey(
    repository: RepositoryState,
    issues: readonly BoardIssue[],
  ): RepositoryState {
    if (!repository.branch) return repository;
    const key = extractIssueKey(repository.branch, projectKeysOf(issues));
    return { ...repository, ...(key ? { branchIssueKey: key } : {}) };
  }

  /** The loaded issue for a key, when the board happens to hold it. */
  issue(key: string): BoardIssue | undefined {
    const wanted = key.toUpperCase();
    return this.data.issues.find((issue) => issue.key.toUpperCase() === wanted);
  }

  // -------------------------------------------------------------- scheduling

  private scheduleAutoRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    const minutes = readBoardConfig().autoRefreshMinutes;
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    this.refreshTimer = setInterval(
      () => {
        // Only while the window has focus: a background window polling Jira
        // every few minutes for hours is someone else's rate limit.
        if (vscode.window.state.focused) void this.refresh({ reason: 'auto refresh' });
      },
      Math.max(1, minutes) * 60_000,
    );
  }

  /**
   * Watch `.git/HEAD` so switching branch anywhere — the Git view, a terminal,
   * another tool — moves the board immediately instead of on the next focus.
   */
  private watchHead(): void {
    const folder = getWorkspaceFolder();
    if (!folder) return;
    try {
      this.headWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, '.git/HEAD'),
      );
      const onChange = (): void => void this.refreshRepository();
      this.headWatcher.onDidChange(onChange);
      this.headWatcher.onDidCreate(onChange);
    } catch (error) {
      // A virtual or unusual workspace may refuse the pattern; window focus
      // still keeps the branch banner current.
      this.log(
        `[jira] could not watch .git/HEAD — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
