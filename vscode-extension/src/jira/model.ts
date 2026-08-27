/**
 * The Jira board's data model: the issue shape the UI renders, the JQL that
 * fills it, and everything derived from a loaded set — filters, warnings and
 * statistics.
 *
 * Deliberately free of `vscode` and of the HTTP client, so every rule in here
 * is unit-testable without an extension host or a Jira server. The split that
 * matters for the UI is which filters cost a round-trip:
 *
 *   - **Server-side** (they go into the JQL, so changing one refetches):
 *     scope, projects, status categories, open-sprint, sort order.
 *   - **Client-side** ({@link applyFilters}, instant on the loaded set):
 *     exact status, due-date bucket, free text, warning kind.
 *
 * That is why the loaded set is capped and reported: a client-side filter can
 * only ever narrow what the server already returned.
 */

import { JiraIssue, JiraUser } from '../atlassian/client';

// --------------------------------------------------------------------- issues

/** Jira's three workflow buckets, which every status maps into. */
export type StatusCategory = 'todo' | 'inprogress' | 'done';

export const STATUS_CATEGORIES: readonly StatusCategory[] = [
  'todo',
  'inprogress',
  'done',
];

export const CATEGORY_LABELS: Record<StatusCategory, string> = {
  todo: 'To do',
  inprogress: 'In progress',
  done: 'Done',
};

/** Fields the board needs. Narrower than a full issue: this is a list view. */
export const BOARD_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'priority',
  'assignee',
  'reporter',
  'duedate',
  'created',
  'updated',
  'labels',
  'components',
  'fixVersions',
  'parent',
  'resolution',
] as const;

/** One issue, flattened into exactly what the board draws. */
export interface BoardIssue {
  key: string;
  summary: string;
  status: string;
  category: StatusCategory;
  type: string;
  priority?: string;
  assignee?: string;
  /** True when the issue is assigned to the authenticated user. */
  assignedToMe: boolean;
  reporter?: string;
  /** `YYYY-MM-DD`, as Jira stores a due date — no time, no zone. */
  dueDate?: string;
  created?: string;
  updated?: string;
  labels: string[];
  components: string[];
  fixVersions: string[];
  parentKey?: string;
  resolved: boolean;
  url: string;
}

function firstString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Pull a display name out of the several shapes Jira uses for one. */
function nameOf(value: unknown): string | undefined {
  if (typeof value === 'string') return firstString(value);
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return (
    firstString(record.displayName) ??
    firstString(record.name) ??
    firstString(record.value) ??
    undefined
  );
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => nameOf(entry)).filter((entry): entry is string => Boolean(entry));
}

/** Browse URL for an issue, which is stable across both deployments. */
export function issueUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}`;
}

/**
 * Map a status onto a workflow bucket.
 *
 * `statusCategory.key` is the reliable signal and is the same on Server/DC and
 * Cloud. A status without one (an older Server workflow, a trimmed field set)
 * falls back to matching the name, because putting everything in "To do" would
 * silently empty the In-progress column.
 */
export function statusCategoryOf(status: unknown): StatusCategory {
  const record = (status ?? {}) as Record<string, unknown>;
  const category = (record.statusCategory ?? {}) as Record<string, unknown>;
  const key = firstString(category.key)?.toLowerCase();
  if (key === 'done') return 'done';
  if (key === 'indeterminate') return 'inprogress';
  if (key === 'new') return 'todo';

  const name = (nameOf(status) ?? '').toLowerCase();
  if (/(done|closed|resolved|complete|released|verified)/.test(name)) return 'done';
  if (/(progress|review|develop|testing|qa|implement|doing|start)/.test(name)) {
    return 'inprogress';
  }
  return 'todo';
}

/**
 * How a user is identified for "is this mine?".
 *
 * Cloud has `accountId`, Server/DC has `name`/`key`, and a trimmed payload may
 * carry only a display name — so all of them are compared rather than assuming
 * one deployment.
 */
export function userIdentities(user: JiraUser | undefined): string[] {
  if (!user) return [];
  return [user.accountId, user.name, user.key, user.emailAddress, user.displayName]
    .map((value) => firstString(value)?.toLowerCase())
    .filter((value): value is string => Boolean(value));
}

/** Flatten one API issue into a {@link BoardIssue}. */
export function normalizeIssue(
  raw: JiraIssue,
  baseUrl: string,
  me?: JiraUser,
): BoardIssue {
  const fields = (raw.fields ?? {}) as Record<string, unknown>;
  const assignee = (fields.assignee ?? undefined) as JiraUser | undefined;
  const mine = userIdentities(me);
  const assigneeIds = userIdentities(assignee);
  const parent = (fields.parent ?? undefined) as { key?: string } | undefined;

  return {
    key: raw.key,
    summary: firstString(fields.summary) ?? raw.key,
    status: nameOf(fields.status) ?? 'Unknown',
    category: statusCategoryOf(fields.status),
    type: nameOf(fields.issuetype) ?? 'Task',
    priority: nameOf(fields.priority),
    assignee: nameOf(fields.assignee),
    assignedToMe:
      mine.length > 0 && assigneeIds.some((identity) => mine.includes(identity)),
    reporter: nameOf(fields.reporter),
    dueDate: firstString(fields.duedate),
    created: firstString(fields.created),
    updated: firstString(fields.updated),
    labels: stringList(fields.labels),
    components: stringList(fields.components),
    fixVersions: stringList(fields.fixVersions),
    parentKey: firstString(parent?.key),
    // A resolution is set the moment the issue is actually finished; the Done
    // category alone also covers statuses like "Won't do".
    resolved: Boolean(fields.resolution) || statusCategoryOf(fields.status) === 'done',
    url: issueUrl(baseUrl, raw.key),
  };
}

// -------------------------------------------------------------------- filters

/** Whose issues to load. */
export type BoardScope = 'mine' | 'reported' | 'watched' | 'all';

/** Due-date bucket, applied to the loaded set. */
export type DueFilter = 'any' | 'overdue' | 'today' | 'week' | 'none';

export type BoardSort = 'due' | 'updated' | 'priority' | 'status' | 'key';

export interface BoardFilters {
  scope: BoardScope;
  /** Free-text project keys, comma or space separated. Empty means every one. */
  projects: string;
  categories: StatusCategory[];
  /** Exact status names, narrowing {@link categories} client-side. */
  statuses: string[];
  due: DueFilter;
  text: string;
  sort: BoardSort;
  openSprintsOnly: boolean;
  /** Set by clicking a warning tile; `undefined` shows everything. */
  warning?: WarningKind;
}

export const DEFAULT_FILTERS: BoardFilters = {
  scope: 'mine',
  projects: '',
  categories: ['todo', 'inprogress'],
  statuses: [],
  due: 'any',
  text: '',
  sort: 'due',
  openSprintsOnly: false,
};

/**
 * Merge stored or webview-sent filters onto the defaults.
 *
 * Everything is re-validated rather than trusted: these values arrive from
 * persisted state written by an older version and from webview messages, and a
 * bad `sort` or a non-array `categories` would otherwise reach the JQL.
 */
export function normalizeFilters(value: unknown): BoardFilters {
  const raw = (value ?? {}) as Record<string, unknown>;
  const scopes: BoardScope[] = ['mine', 'reported', 'watched', 'all'];
  const dues: DueFilter[] = ['any', 'overdue', 'today', 'week', 'none'];
  const sorts: BoardSort[] = ['due', 'updated', 'priority', 'status', 'key'];

  const requested: unknown[] = Array.isArray(raw.categories) ? raw.categories : [];
  const categories = Array.isArray(raw.categories)
    ? STATUS_CATEGORIES.filter((category) => requested.includes(category))
    : DEFAULT_FILTERS.categories;

  const statuses = Array.isArray(raw.statuses)
    ? raw.statuses.filter((entry): entry is string => typeof entry === 'string')
    : [];

  const warning = WARNING_KINDS.find((kind) => kind === raw.warning);

  return {
    scope: scopes.find((scope) => scope === raw.scope) ?? DEFAULT_FILTERS.scope,
    projects: typeof raw.projects === 'string' ? raw.projects : '',
    // An empty category set would load the whole backlog including Done; treat
    // it as "the user cleared the chips" and fall back to the default two.
    categories: categories.length > 0 ? categories : DEFAULT_FILTERS.categories,
    statuses,
    due: dues.find((due) => due === raw.due) ?? 'any',
    text: typeof raw.text === 'string' ? raw.text : '',
    sort: sorts.find((sort) => sort === raw.sort) ?? DEFAULT_FILTERS.sort,
    openSprintsOnly: raw.openSprintsOnly === true,
    ...(warning ? { warning } : {}),
  };
}

/** Whether a change between two filter sets needs a new query. */
export function needsRefetch(before: BoardFilters, after: BoardFilters): boolean {
  return (
    before.scope !== after.scope ||
    before.projects.trim() !== after.projects.trim() ||
    before.openSprintsOnly !== after.openSprintsOnly ||
    before.categories.join(',') !== after.categories.join(',')
  );
}

/**
 * Project keys out of a free-text box.
 *
 * Split on anything a key cannot contain, so `TPLD, WEB`, `tpld web` and
 * `TPLD;WEB` all work, and keep only key-shaped tokens. Filtering rather than
 * escaping is what makes the generated JQL safe: no quote, parenthesis or
 * operator character in the input can reach the query.
 */
export function parseProjectKeys(raw: string): string[] {
  const keys = raw
    .split(/[^A-Za-z0-9_]+/)
    .filter((entry) => /^[A-Za-z][A-Za-z0-9_]*$/.test(entry))
    .map((entry) => entry.toUpperCase());
  return [...new Set(keys)];
}

/**
 * Jira's internal status-category ids: 2 = To Do, 4 = In Progress, 3 = Done.
 *
 * The ids rather than the names, because JQL matches a category name against
 * the *localised* name — on a Jira running in another language, and on older
 * Data Center versions that spelled the third category differently, matching by
 * name silently returns nothing. The ids are fixed on both deployments.
 */
const CATEGORY_JQL: Record<StatusCategory, number> = {
  todo: 2,
  inprogress: 4,
  done: 3,
};

const SORT_JQL: Record<BoardSort, string> = {
  due: 'duedate ASC, priority DESC, updated DESC',
  updated: 'updated DESC',
  priority: 'priority DESC, duedate ASC',
  status: 'status ASC, duedate ASC',
  key: 'key DESC',
};

/**
 * Build the query for a filter set.
 *
 * `override` is the escape hatch for a team whose board is defined by a saved
 * filter or a board-specific clause: it replaces every generated condition,
 * and only the ordering is appended (when it does not bring its own).
 */
export function buildJql(filters: BoardFilters, override?: string): string {
  const order = `ORDER BY ${SORT_JQL[filters.sort]}`;
  const custom = override?.trim();
  if (custom) {
    return /\border\s+by\b/i.test(custom) ? custom : `${custom} ${order}`;
  }

  const clauses: string[] = [];
  if (filters.scope === 'mine') clauses.push('assignee = currentUser()');
  else if (filters.scope === 'reported') clauses.push('reporter = currentUser()');
  else if (filters.scope === 'watched') clauses.push('watcher = currentUser()');

  const projects = parseProjectKeys(filters.projects);
  if (projects.length === 1) clauses.push(`project = ${projects[0]}`);
  else if (projects.length > 1) clauses.push(`project in (${projects.join(', ')})`);

  // Every category selected is the same query as no category clause at all, and
  // the shorter JQL is the one a user can read in the "showing" line.
  if (filters.categories.length > 0 && filters.categories.length < STATUS_CATEGORIES.length) {
    const ids = filters.categories.map((category) => CATEGORY_JQL[category]);
    clauses.push(
      ids.length === 1 ? `statusCategory = ${ids[0]}` : `statusCategory in (${ids.join(', ')})`,
    );
  }

  if (filters.openSprintsOnly) clauses.push('sprint in openSprints()');

  return clauses.length > 0 ? `${clauses.join(' AND ')} ${order}` : order;
}

// ------------------------------------------------------------------ due dates

/** Local `YYYY-MM-DD` for a moment — Jira due dates carry no zone. */
export function isoDay(at: Date): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, '0');
  const day = `${at.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Whole days from today until a due date: negative in the past, 0 today.
 * Computed on calendar days (UTC midnights) so a timezone offset can never
 * make "due today" read as overdue.
 */
export function daysUntil(dueDate: string, now: Date): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dueDate);
  if (!match) return undefined;
  const [, year, month, day] = match;
  const due = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86_400_000);
}

/** Whole days since a Jira timestamp, or `undefined` when unparseable. */
export function daysSince(timestamp: string | undefined, now: Date): number | undefined {
  if (!timestamp) return undefined;
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));
}

export type DueBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';

export function dueBucketOf(issue: BoardIssue, now: Date): DueBucket {
  if (!issue.dueDate) return 'none';
  const days = daysUntil(issue.dueDate, now);
  if (days === undefined) return 'none';
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days <= 7) return 'week';
  return 'later';
}

// ------------------------------------------------------------------ warnings

export type WarningKind =
  | 'overdue'
  | 'dueSoon'
  | 'stale'
  | 'unassigned'
  | 'noDueDate';

export const WARNING_KINDS: readonly WarningKind[] = [
  'overdue',
  'dueSoon',
  'stale',
  'unassigned',
  'noDueDate',
];

export type WarningSeverity = 'high' | 'medium' | 'low';

export interface IssueWarning {
  kind: WarningKind;
  severity: WarningSeverity;
  /** One short sentence, shown on the card and in the warning tile. */
  label: string;
}

export interface WarningOptions {
  /** A due date this many days out or closer is "due soon". */
  dueSoonDays: number;
  /** In-progress work untouched for this long is stale. */
  staleDays: number;
}

export const DEFAULT_WARNING_OPTIONS: WarningOptions = {
  dueSoonDays: 3,
  staleDays: 5,
};

/**
 * Everything worth flagging on one issue.
 *
 * Nothing is reported for a finished issue: a closed ticket that was late is
 * history, and flagging it would bury the ones still needing attention.
 */
export function issueWarnings(
  issue: BoardIssue,
  now: Date,
  options: WarningOptions = DEFAULT_WARNING_OPTIONS,
): IssueWarning[] {
  if (issue.resolved) return [];
  const warnings: IssueWarning[] = [];
  const days = issue.dueDate ? daysUntil(issue.dueDate, now) : undefined;

  if (days !== undefined && days < 0) {
    warnings.push({
      kind: 'overdue',
      severity: 'high',
      label:
        days === -1 ? 'Overdue by 1 day' : `Overdue by ${Math.abs(days)} days`,
    });
  } else if (days !== undefined && days <= Math.max(0, options.dueSoonDays)) {
    warnings.push({
      kind: 'dueSoon',
      severity: 'medium',
      label: days === 0 ? 'Due today' : `Due in ${days} day${days === 1 ? '' : 's'}`,
    });
  }

  const untouched = daysSince(issue.updated, now);
  if (
    issue.category === 'inprogress' &&
    untouched !== undefined &&
    untouched >= Math.max(1, options.staleDays)
  ) {
    warnings.push({
      kind: 'stale',
      severity: 'medium',
      label: `In progress with no update for ${untouched} days`,
    });
  }

  if (!issue.assignee) {
    warnings.push({ kind: 'unassigned', severity: 'low', label: 'Nobody is assigned' });
  }

  if (issue.category === 'inprogress' && !issue.dueDate) {
    warnings.push({ kind: 'noDueDate', severity: 'low', label: 'In progress with no due date' });
  }

  return warnings;
}

export const WARNING_LABELS: Record<WarningKind, string> = {
  overdue: 'Overdue',
  dueSoon: 'Due soon',
  stale: 'Stale',
  unassigned: 'Unassigned',
  noDueDate: 'No due date',
};

export const WARNING_SEVERITY: Record<WarningKind, WarningSeverity> = {
  overdue: 'high',
  dueSoon: 'medium',
  stale: 'medium',
  unassigned: 'low',
  noDueDate: 'low',
};

/** The most severe warning on an issue, which is what its card shows. */
export function worstWarning(warnings: IssueWarning[]): IssueWarning | undefined {
  const rank: Record<WarningSeverity, number> = { high: 3, medium: 2, low: 1 };
  return warnings.reduce<IssueWarning | undefined>((worst, warning) => {
    if (!worst || rank[warning.severity] > rank[worst.severity]) return warning;
    return worst;
  }, undefined);
}

// ---------------------------------------------------------- client-side view

const PRIORITY_RANK: Record<string, number> = {
  blocker: 5,
  highest: 5,
  critical: 4,
  high: 4,
  major: 4,
  medium: 3,
  normal: 3,
  low: 2,
  minor: 2,
  lowest: 1,
  trivial: 1,
};

export function priorityRank(priority: string | undefined): number {
  return PRIORITY_RANK[(priority ?? '').toLowerCase()] ?? 0;
}

/** Sort a loaded set. Mirrors {@link SORT_JQL} so a re-sort needs no refetch. */
export function sortIssues(issues: BoardIssue[], sort: BoardSort): BoardIssue[] {
  const byDue = (issue: BoardIssue): string => issue.dueDate ?? '9999-12-31';
  const copy = [...issues];
  copy.sort((left, right) => {
    switch (sort) {
      case 'due':
        return (
          byDue(left).localeCompare(byDue(right)) ||
          priorityRank(right.priority) - priorityRank(left.priority) ||
          left.key.localeCompare(right.key)
        );
      case 'updated':
        return (right.updated ?? '').localeCompare(left.updated ?? '');
      case 'priority':
        return (
          priorityRank(right.priority) - priorityRank(left.priority) ||
          byDue(left).localeCompare(byDue(right))
        );
      case 'status':
        return (
          left.status.localeCompare(right.status) ||
          byDue(left).localeCompare(byDue(right))
        );
      case 'key':
        return right.key.localeCompare(left.key, undefined, { numeric: true });
      default:
        return 0;
    }
  });
  return copy;
}

/** Apply the filters that do not need a round-trip. */
export function applyFilters(
  issues: BoardIssue[],
  filters: BoardFilters,
  now: Date,
  options: WarningOptions = DEFAULT_WARNING_OPTIONS,
): BoardIssue[] {
  const needle = filters.text.trim().toLowerCase();
  const statuses = new Set(filters.statuses.map((status) => status.toLowerCase()));

  const matched = issues.filter((issue) => {
    if (!filters.categories.includes(issue.category)) return false;
    if (statuses.size > 0 && !statuses.has(issue.status.toLowerCase())) return false;

    if (filters.due !== 'any') {
      const bucket = dueBucketOf(issue, now);
      if (filters.due === 'week') {
        // "This week" is a deadline horizon, so anything already late belongs
        // in it — an overdue ticket is the most urgent thing due this week.
        if (bucket !== 'overdue' && bucket !== 'today' && bucket !== 'week') return false;
      } else if (filters.due === 'none') {
        if (bucket !== 'none') return false;
      } else if (bucket !== filters.due) return false;
    }

    if (filters.warning) {
      const kinds = issueWarnings(issue, now, options).map((warning) => warning.kind);
      if (!kinds.includes(filters.warning)) return false;
    }

    if (needle) {
      const haystack = [
        issue.key,
        issue.summary,
        issue.status,
        issue.type,
        issue.assignee ?? '',
        issue.labels.join(' '),
        issue.components.join(' '),
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    return true;
  });

  return sortIssues(matched, filters.sort);
}

// ----------------------------------------------------------------- statistics

export interface Counted {
  name: string;
  count: number;
}

export interface BoardStats {
  total: number;
  byCategory: Record<StatusCategory, number>;
  byStatus: Counted[];
  byAssignee: Counted[];
  byPriority: Counted[];
  byType: Counted[];
  dueBuckets: Record<DueBucket, number>;
  warnings: Record<WarningKind, number>;
  /** Issues carrying at least one warning — the headline number. */
  flagged: number;
  /** Share of the set that is done, 0–100. */
  completion: number;
}

function tally(values: string[]): Counted[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

export function computeStats(
  issues: BoardIssue[],
  now: Date,
  options: WarningOptions = DEFAULT_WARNING_OPTIONS,
): BoardStats {
  const byCategory: Record<StatusCategory, number> = { todo: 0, inprogress: 0, done: 0 };
  const dueBuckets: Record<DueBucket, number> = {
    overdue: 0,
    today: 0,
    week: 0,
    later: 0,
    none: 0,
  };
  const warnings: Record<WarningKind, number> = {
    overdue: 0,
    dueSoon: 0,
    stale: 0,
    unassigned: 0,
    noDueDate: 0,
  };
  let flagged = 0;

  for (const issue of issues) {
    byCategory[issue.category] += 1;
    dueBuckets[dueBucketOf(issue, now)] += 1;
    const issueWarningKinds = issueWarnings(issue, now, options);
    if (issueWarningKinds.length > 0) flagged += 1;
    for (const warning of issueWarningKinds) warnings[warning.kind] += 1;
  }

  return {
    total: issues.length,
    byCategory,
    byStatus: tally(issues.map((issue) => issue.status)),
    byAssignee: tally(issues.map((issue) => issue.assignee ?? 'Unassigned')),
    byPriority: tally(issues.map((issue) => issue.priority ?? 'None')),
    byType: tally(issues.map((issue) => issue.type)),
    dueBuckets,
    warnings,
    flagged,
    completion:
      issues.length === 0 ? 0 : Math.round((byCategory.done / issues.length) * 100),
  };
}

/** A short, human summary of what the board is currently showing. */
export function describeFilters(filters: BoardFilters): string {
  const scope: Record<BoardScope, string> = {
    mine: 'Assigned to me',
    reported: 'Reported by me',
    watched: 'Watched by me',
    all: 'Everyone',
  };
  const parts = [scope[filters.scope]];
  const projects = parseProjectKeys(filters.projects);
  if (projects.length > 0) parts.push(projects.join(', '));
  if (filters.categories.length < STATUS_CATEGORIES.length) {
    parts.push(filters.categories.map((category) => CATEGORY_LABELS[category]).join(' + '));
  }
  if (filters.openSprintsOnly) parts.push('open sprints');
  if (filters.due !== 'any') {
    const due: Record<DueFilter, string> = {
      any: '',
      overdue: 'overdue',
      today: 'due today',
      week: 'due this week',
      none: 'no due date',
    };
    parts.push(due[filters.due]);
  }
  if (filters.warning) parts.push(WARNING_LABELS[filters.warning].toLowerCase());
  if (filters.statuses.length > 0) parts.push(filters.statuses.join(' / '));
  if (filters.text.trim()) parts.push(`“${filters.text.trim()}”`);
  return parts.filter(Boolean).join(' · ');
}
