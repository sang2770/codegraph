import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const {
  applyFilters,
  buildJql,
  computeStats,
  DEFAULT_FILTERS,
  describeFilters,
  dueBucketOf,
  daysUntil,
  issueWarnings,
  needsRefetch,
  normalizeFilters,
  normalizeIssue,
  normalizeProjects,
  parseProjectKeys,
  sortIssues,
  statusCategoryOf,
  toggleProjectKey,
  transitionCategory,
  transitionsToCategory,
} = loadTypeScript('jira/model.ts');

const { composeView, projectKeysOf } = loadTypeScript('jira/service.ts', {
  vscode: {
    EventEmitter: class {
      constructor() {
        this.event = () => ({ dispose() {} });
      }
      fire() {}
      dispose() {}
    },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { onDidChangeWindowState: () => ({ dispose() {} }), state: { focused: true } },
  },
});

// Local noon, so "today" is the same calendar day in every timezone the suite
// might run in.
const NOW = new Date(2026, 7, 27, 12, 0, 0);

function issue(overrides = {}) {
  return {
    key: 'TPLD-1',
    summary: 'Chart lags when the window is resized',
    status: 'In Progress',
    category: 'inprogress',
    type: 'Bug',
    priority: 'High',
    assignee: 'Sang Nguyen',
    assignedToMe: true,
    labels: [],
    components: [],
    fixVersions: [],
    resolved: false,
    updated: '2026-08-26T09:00:00.000+0000',
    url: 'https://jira.example.com/browse/TPLD-1',
    ...overrides,
  };
}

// ------------------------------------------------------------------ normalize

test('flattens a Server/DC issue payload', () => {
  const flattened = normalizeIssue(
    {
      key: 'TPLD-958',
      fields: {
        summary: 'Fix chart lag',
        status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        issuetype: { name: 'Bug' },
        priority: { name: 'High' },
        assignee: { name: 'sang2.nguyen', displayName: 'Sang Nguyen' },
        reporter: { displayName: 'QA Bot' },
        duedate: '2026-08-30',
        labels: ['perf', 'ui'],
        components: [{ name: 'charts' }],
        fixVersions: [{ name: '2.2.0' }],
        parent: { key: 'TPLD-900' },
      },
    },
    'https://jira.example.com/',
    { name: 'sang2.nguyen' },
  );

  assert.equal(flattened.key, 'TPLD-958');
  assert.equal(flattened.category, 'inprogress');
  assert.equal(flattened.assignee, 'Sang Nguyen');
  assert.equal(flattened.assignedToMe, true);
  assert.equal(flattened.dueDate, '2026-08-30');
  assert.deepEqual(flattened.labels, ['perf', 'ui']);
  assert.deepEqual(flattened.components, ['charts']);
  assert.equal(flattened.parentKey, 'TPLD-900');
  assert.equal(flattened.resolved, false);
  // The trailing slash on the base URL must not double up.
  assert.equal(flattened.url, 'https://jira.example.com/browse/TPLD-958');
});

test('an issue assigned to someone else is not mine', () => {
  const flattened = normalizeIssue(
    { key: 'TPLD-1', fields: { assignee: { accountId: 'other' } } },
    'https://jira.example.com',
    { accountId: 'me' },
  );
  assert.equal(flattened.assignedToMe, false);
});

test('an unauthenticated session marks nothing as mine', () => {
  const flattened = normalizeIssue(
    { key: 'TPLD-1', fields: { assignee: { accountId: 'someone' } } },
    'https://jira.example.com',
    undefined,
  );
  assert.equal(flattened.assignedToMe, false);
});

test('a status with no category falls back to matching its name', () => {
  assert.equal(statusCategoryOf({ name: 'Code Review' }), 'inprogress');
  assert.equal(statusCategoryOf({ name: 'Closed' }), 'done');
  assert.equal(statusCategoryOf({ name: 'Backlog' }), 'todo');
  // An explicit category always wins over the name.
  assert.equal(
    statusCategoryOf({ name: 'Closed', statusCategory: { key: 'indeterminate' } }),
    'inprogress',
  );
});

test('a Done category counts as resolved even with no resolution field', () => {
  const flattened = normalizeIssue(
    { key: 'TPLD-2', fields: { status: { name: "Won't Do", statusCategory: { key: 'done' } } } },
    'https://jira.example.com',
  );
  assert.equal(flattened.resolved, true);
});

// ------------------------------------------------------------------------ JQL

test('builds JQL for the default filters', () => {
  assert.equal(
    buildJql(DEFAULT_FILTERS),
    'assignee = currentUser() AND statusCategory in (2, 4) ORDER BY duedate ASC, priority DESC, updated DESC',
  );
});

test('drops the category clause when every category is selected', () => {
  const jql = buildJql({
    ...DEFAULT_FILTERS,
    scope: 'all',
    categories: ['todo', 'inprogress', 'done'],
    sort: 'updated',
  });
  assert.equal(jql, 'ORDER BY updated DESC');
});

test('scopes by project, watcher and open sprints', () => {
  const jql = buildJql({
    ...DEFAULT_FILTERS,
    scope: 'watched',
    projects: 'tpld, web',
    openSprintsOnly: true,
    categories: ['inprogress'],
  });
  assert.equal(
    jql,
    'watcher = currentUser() AND project in (TPLD, WEB) AND statusCategory = 4 AND sprint in openSprints() ORDER BY duedate ASC, priority DESC, updated DESC',
  );
});

test('a JQL override replaces the generated clauses and keeps an ordering', () => {
  assert.equal(
    buildJql(DEFAULT_FILTERS, 'filter = "My Team"'),
    'filter = "My Team" ORDER BY duedate ASC, priority DESC, updated DESC',
  );
  assert.equal(
    buildJql(DEFAULT_FILTERS, 'filter = "My Team" ORDER BY rank'),
    'filter = "My Team" ORDER BY rank',
  );
});

test('project keys are parsed leniently and rubbish is dropped', () => {
  assert.deepEqual(parseProjectKeys(' tpld ,web;  9x , A_B , TPLD '), ['TPLD', 'WEB', 'A_B']);
});

test('a crafted project box cannot inject JQL', () => {
  // Non-key characters are dropped rather than escaped, so no quote, paren or
  // comparison from the input can reach the query.
  const jql = buildJql({ ...DEFAULT_FILTERS, projects: 'TPLD") OR (1=1' });
  assert.equal(
    jql,
    'assignee = currentUser() AND project in (TPLD, OR) AND statusCategory in (2, 4) ORDER BY duedate ASC, priority DESC, updated DESC',
  );
});

// -------------------------------------------------------------------- filters

test('normalizeFilters repairs stored rubbish', () => {
  const filters = normalizeFilters({
    scope: 'nonsense',
    categories: 'inprogress',
    statuses: ['Open', 7],
    due: 'yesterday',
    sort: 'colour',
    warning: 'meteor',
    openSprintsOnly: 'yes',
  });
  assert.equal(filters.scope, 'mine');
  assert.deepEqual(filters.categories, DEFAULT_FILTERS.categories);
  assert.deepEqual(filters.statuses, ['Open']);
  assert.equal(filters.due, 'any');
  assert.equal(filters.sort, 'due');
  assert.equal(filters.warning, undefined);
  assert.equal(filters.openSprintsOnly, false);
});

test('clearing every progress chip falls back to the default two', () => {
  assert.deepEqual(normalizeFilters({ categories: [] }).categories, DEFAULT_FILTERS.categories);
});

test('only the filters in the query cost a refetch', () => {
  const base = normalizeFilters(DEFAULT_FILTERS);
  assert.equal(needsRefetch(base, { ...base, text: 'chart' }), false);
  assert.equal(needsRefetch(base, { ...base, due: 'overdue' }), false);
  assert.equal(needsRefetch(base, { ...base, sort: 'updated' }), false);
  assert.equal(needsRefetch(base, { ...base, statuses: ['Open'] }), false);
  assert.equal(needsRefetch(base, { ...base, scope: 'all' }), true);
  assert.equal(needsRefetch(base, { ...base, projects: 'TPLD' }), true);
  assert.equal(needsRefetch(base, { ...base, categories: ['done'] }), true);
  assert.equal(needsRefetch(base, { ...base, openSprintsOnly: true }), true);
});

test('due buckets are calendar days, so due today is never late', () => {
  assert.equal(daysUntil('2026-08-27', NOW), 0);
  assert.equal(daysUntil('2026-08-25', NOW), -2);
  assert.equal(daysUntil('nonsense', NOW), undefined);
  assert.equal(dueBucketOf(issue({ dueDate: '2026-08-27' }), NOW), 'today');
  assert.equal(dueBucketOf(issue({ dueDate: '2026-08-26' }), NOW), 'overdue');
  assert.equal(dueBucketOf(issue({ dueDate: '2026-09-01' }), NOW), 'week');
  assert.equal(dueBucketOf(issue({ dueDate: '2026-10-01' }), NOW), 'later');
  assert.equal(dueBucketOf(issue({}), NOW), 'none');
});

test('the week filter includes what is already overdue', () => {
  const issues = [
    issue({ key: 'TPLD-1', dueDate: '2026-08-20' }),
    issue({ key: 'TPLD-2', dueDate: '2026-08-29' }),
    issue({ key: 'TPLD-3', dueDate: '2026-12-01' }),
  ];
  const visible = applyFilters(issues, { ...DEFAULT_FILTERS, due: 'week' }, NOW);
  assert.deepEqual(
    visible.map((entry) => entry.key),
    ['TPLD-1', 'TPLD-2'],
  );
});

test('text search covers key, summary, assignee and labels', () => {
  const issues = [
    issue({ key: 'TPLD-1', summary: 'Chart lag' }),
    issue({ key: 'TPLD-2', summary: 'Login broken', labels: ['auth'] }),
  ];
  const search = (text) =>
    applyFilters(issues, { ...DEFAULT_FILTERS, text }, NOW).map((entry) => entry.key);
  assert.deepEqual(search('chart'), ['TPLD-1']);
  assert.deepEqual(search('AUTH'), ['TPLD-2']);
  assert.deepEqual(search('tpld-2'), ['TPLD-2']);
  assert.deepEqual(search('nothing here'), []);
});

test('the category filter still applies to a loaded set', () => {
  const issues = [
    issue({ key: 'TPLD-1', category: 'inprogress' }),
    issue({ key: 'TPLD-2', category: 'done', resolved: true, status: 'Done' }),
  ];
  const visible = applyFilters(issues, { ...DEFAULT_FILTERS, categories: ['done'] }, NOW);
  assert.deepEqual(
    visible.map((entry) => entry.key),
    ['TPLD-2'],
  );
});

test('sorting by due date puts the undated last and breaks ties on priority', () => {
  const issues = [
    issue({ key: 'TPLD-1', dueDate: undefined }),
    issue({ key: 'TPLD-2', dueDate: '2026-09-01', priority: 'Low' }),
    issue({ key: 'TPLD-3', dueDate: '2026-09-01', priority: 'Highest' }),
    issue({ key: 'TPLD-4', dueDate: '2026-08-20' }),
  ];
  assert.deepEqual(
    sortIssues(issues, 'due').map((entry) => entry.key),
    ['TPLD-4', 'TPLD-3', 'TPLD-2', 'TPLD-1'],
  );
});

// ------------------------------------------------------------------- warnings

test('an overdue open issue is flagged high', () => {
  const warnings = issueWarnings(issue({ dueDate: '2026-08-24' }), NOW);
  assert.equal(warnings[0].kind, 'overdue');
  assert.equal(warnings[0].severity, 'high');
  assert.match(warnings[0].label, /Overdue by 3 days/);
});

test('due soon respects the configured horizon', () => {
  const soon = issue({ dueDate: '2026-08-29' });
  assert.equal(issueWarnings(soon, NOW, { dueSoonDays: 3, staleDays: 5 })[0].kind, 'dueSoon');
  assert.deepEqual(issueWarnings(soon, NOW, { dueSoonDays: 1, staleDays: 5 }), []);
});

test('overdue and due-soon are never reported together', () => {
  const kinds = issueWarnings(issue({ dueDate: '2026-08-01' }), NOW).map((w) => w.kind);
  assert.equal(kinds.includes('overdue'), true);
  assert.equal(kinds.includes('dueSoon'), false);
});

test('a stale in-progress issue is flagged, a stale to-do one is not', () => {
  const stale = { updated: '2026-08-10T09:00:00.000+0000' };
  assert.equal(
    issueWarnings(issue(stale), NOW).some((warning) => warning.kind === 'stale'),
    true,
  );
  assert.equal(
    issueWarnings(issue({ ...stale, category: 'todo', status: 'Open' }), NOW).some(
      (warning) => warning.kind === 'stale',
    ),
    false,
  );
});

test('a finished issue carries no warnings at all', () => {
  const done = issue({
    category: 'done',
    status: 'Done',
    resolved: true,
    dueDate: '2026-01-01',
    assignee: undefined,
  });
  assert.deepEqual(issueWarnings(done, NOW), []);
});

test('unassigned and missing-due-date are flagged low', () => {
  const kinds = issueWarnings(issue({ assignee: undefined, dueDate: undefined }), NOW).map(
    (warning) => warning.kind,
  );
  assert.deepEqual(kinds, ['unassigned', 'noDueDate']);
});

test('filtering by a warning keeps only the issues that carry it', () => {
  const issues = [
    issue({ key: 'TPLD-1', dueDate: '2026-08-01' }),
    issue({ key: 'TPLD-2', dueDate: '2026-12-01' }),
  ];
  const visible = applyFilters(issues, { ...DEFAULT_FILTERS, warning: 'overdue' }, NOW);
  assert.deepEqual(
    visible.map((entry) => entry.key),
    ['TPLD-1'],
  );
});

// ----------------------------------------------------------------- statistics

test('statistics count categories, deadlines and warnings', () => {
  const issues = [
    issue({ key: 'TPLD-1', dueDate: '2026-08-01' }),
    issue({ key: 'TPLD-2', category: 'todo', status: 'Open', assignee: undefined }),
    issue({
      key: 'TPLD-3',
      category: 'done',
      status: 'Done',
      resolved: true,
      dueDate: '2026-08-27',
    }),
  ];
  const stats = computeStats(issues, NOW);

  assert.equal(stats.total, 3);
  assert.deepEqual(stats.byCategory, { todo: 1, inprogress: 1, done: 1 });
  assert.equal(stats.dueBuckets.overdue, 1);
  assert.equal(stats.dueBuckets.today, 1);
  assert.equal(stats.dueBuckets.none, 1);
  assert.equal(stats.warnings.overdue, 1);
  assert.equal(stats.warnings.unassigned, 1);
  assert.equal(stats.flagged, 2);
  assert.equal(stats.completion, 33);
  assert.deepEqual(stats.byAssignee[0], { name: 'Sang Nguyen', count: 2 });
});

test('an empty board has no completion rate rather than NaN', () => {
  const stats = computeStats([], NOW);
  assert.equal(stats.completion, 0);
  assert.equal(stats.flagged, 0);
});

test('the filter summary reads as a sentence', () => {
  assert.equal(
    describeFilters({
      ...DEFAULT_FILTERS,
      projects: 'TPLD',
      due: 'overdue',
      text: 'chart',
    }),
    'Assigned to me · TPLD · To do + In progress · overdue · “chart”',
  );
});

// ----------------------------------------------------------------- composeView

test('composeView joins branches onto the cards it shows', () => {
  const data = {
    configured: true,
    issues: [issue({ key: 'TPLD-1' }), issue({ key: 'TPLD-2' })],
    loading: false,
    capped: false,
    jql: '',
    projects: [],
    projectsLoading: false,
    repository: {
      isRepository: true,
      branch: 'feature/TPLD-1-chart-lag',
      branches: [
        {
          name: 'feature/TPLD-1-chart-lag',
          localName: 'feature/TPLD-1-chart-lag',
          isRemote: false,
          isCurrent: true,
          issueKey: 'TPLD-1',
        },
        {
          name: 'origin/feature/TPLD-2-login',
          localName: 'feature/TPLD-2-login',
          isRemote: true,
          isCurrent: false,
          issueKey: 'TPLD-2',
        },
      ],
    },
  };
  const config = {
    maxIssues: 100,
    autoRefreshMinutes: 0,
    warnings: { dueSoonDays: 3, staleDays: 5 },
    branchTemplate: '{prefix}/{key}-{summary}',
    jql: '',
    defaultProject: '',
    statusBar: true,
    baseBranch: '',
    allowWrite: false,
  };

  const view = composeView(data, normalizeFilters(DEFAULT_FILTERS), config, NOW);
  const first = view.cards.find((card) => card.issue.key === 'TPLD-1');
  const second = view.cards.find((card) => card.issue.key === 'TPLD-2');

  assert.equal(first.onBranch, true);
  assert.equal(second.onBranch, false);
  assert.equal(second.branches[0].isRemote, true);
  assert.deepEqual(view.statuses, ['In Progress']);
  assert.equal(view.stats.total, 2);
  assert.equal(view.loadedStats.total, 2);
});

test('project keys come from the loaded issues', () => {
  assert.deepEqual(
    projectKeysOf([issue({ key: 'TPLD-1' }), issue({ key: 'web-9' })]),
    ['TPLD', 'WEB'],
  );
});

// -------------------------------------------------------------------- projects

test('the project list drops what cannot be selected and sorts by key', () => {
  assert.deepEqual(
    normalizeProjects([
      { key: 'web', name: 'Web Client' },
      { key: 'TPLD', name: 'Tool Platform' },
      { name: 'No key at all' },
      { key: 'OLD', name: 'Retired', archived: true },
      { key: 'TPLD', name: 'A duplicate the server returned twice' },
      { key: 'OPS' },
    ]),
    [
      { key: 'OPS', name: 'OPS' },
      { key: 'TPLD', name: 'Tool Platform' },
      { key: 'WEB', name: 'Web Client' },
    ],
  );
});

test('toggling a project key edits the filter text in place', () => {
  assert.equal(toggleProjectKey('', 'tpld'), 'TPLD');
  assert.equal(toggleProjectKey('TPLD', 'WEB'), 'TPLD, WEB');
  assert.equal(toggleProjectKey('TPLD, WEB', 'TPLD'), 'WEB');
  assert.equal(toggleProjectKey('TPLD', 'tpld'), '');
  // A box someone typed by hand is normalised on the way through, not doubled.
  assert.equal(toggleProjectKey('tpld;web', 'OPS'), 'TPLD, WEB, OPS');
  assert.equal(toggleProjectKey('TPLD', '  '), 'TPLD');
});

test('composeView reports the selected projects for the chips', () => {
  const data = {
    configured: true,
    issues: [],
    loading: false,
    capped: false,
    jql: '',
    projects: [{ key: 'TPLD', name: 'Tool Platform' }],
    projectsLoading: false,
    repository: { isRepository: false, branches: [] },
  };
  const config = {
    maxIssues: 100,
    autoRefreshMinutes: 0,
    warnings: { dueSoonDays: 3, staleDays: 5 },
    branchTemplate: '{prefix}/{key}-{summary}',
    jql: '',
    defaultProject: '',
    statusBar: true,
    baseBranch: '',
    allowWrite: false,
  };

  const view = composeView(
    data,
    normalizeFilters({ ...DEFAULT_FILTERS, projects: 'tpld, web' }),
    config,
    NOW,
  );
  assert.deepEqual(view.selectedProjects, ['TPLD', 'WEB']);
});

// ------------------------------------------------------------------ workflow

test('a transition is bucketed by the category of its destination', () => {
  assert.equal(
    transitionCategory({ id: '31', name: 'Done', to: { name: 'Closed', statusCategory: { key: 'done' } } }),
    'done',
  );
  assert.equal(
    transitionCategory({ id: '21', to: { name: 'In Review', statusCategory: { key: 'indeterminate' } } }),
    'inprogress',
  );
  // Server/DC workflows that answer without a category fall back to the name.
  assert.equal(transitionCategory({ id: '11', to: { name: 'In Progress' } }), 'inprogress');
  assert.equal(transitionCategory({ id: '12', to: { name: 'Open' } }), 'todo');
  assert.equal(transitionCategory({ id: '13' }), 'todo');
});

test('a drop onto a column offers only the transitions that land in it', () => {
  const transitions = [
    { id: '11', name: 'Start work', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
    { id: '21', name: 'Review', to: { name: 'In Review', statusCategory: { key: 'indeterminate' } } },
    { id: '31', name: 'Close', to: { name: 'Closed', statusCategory: { key: 'done' } } },
    // No id: Jira cannot be asked to apply it, so it is never a candidate.
    { name: 'Broken', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
  ];

  assert.deepEqual(
    transitionsToCategory(transitions, 'inprogress').map((entry) => entry.id),
    ['11', '21'],
  );
  assert.deepEqual(
    transitionsToCategory(transitions, 'done').map((entry) => entry.id),
    ['31'],
  );
  assert.deepEqual(transitionsToCategory(transitions, 'todo'), []);
});
