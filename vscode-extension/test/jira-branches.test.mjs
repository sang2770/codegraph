import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const {
  branchMatchesIssue,
  branchNameFor,
  extractIssueKey,
  isValidBranchName,
  parseBranchLines,
  planCheckout,
  sanitizeBranchName,
  slugify,
  typePrefix,
} = loadTypeScript('jira/branches.ts');

// -------------------------------------------------------------- issue keys

test('reads an issue key out of the branch shapes people actually use', () => {
  assert.equal(extractIssueKey('feature/TPLD-958-chart-lag'), 'TPLD-958');
  assert.equal(extractIssueKey('feature/tpld-958-chart-lag'), 'TPLD-958');
  assert.equal(extractIssueKey('TPLD-958'), 'TPLD-958');
  assert.equal(extractIssueKey('bugfix/ABC-1_hotfix'), 'ABC-1');
  assert.equal(extractIssueKey('sang/TPLD-958/retry'), 'TPLD-958');
});

test('a branch with no key produces no key', () => {
  assert.equal(extractIssueKey('main'), undefined);
  assert.equal(extractIssueKey('release/v2-1'), undefined);
  assert.equal(extractIssueKey(''), undefined);
  assert.equal(extractIssueKey(undefined), undefined);
});

test('known project keys stop a version fragment reading as a ticket', () => {
  // Syntactically this is a key, which is why the board passes what it loaded.
  assert.equal(extractIssueKey('chore/node-22'), 'NODE-22');
  assert.equal(extractIssueKey('chore/node-22', ['TPLD']), undefined);
  assert.equal(extractIssueKey('chore/node-22-for-TPLD-4', ['TPLD']), 'TPLD-4');
});

test('branchMatchesIssue only matches the issue it was asked about', () => {
  assert.equal(branchMatchesIssue('feature/tpld-958-x', 'TPLD-958'), true);
  assert.equal(branchMatchesIssue('feature/tpld-9581-x', 'TPLD-958'), false);
  assert.equal(branchMatchesIssue('feature/web-958-x', 'TPLD-958'), false);
});

// ------------------------------------------------------------------- slugs

test('slugifies a summary into a readable branch tail', () => {
  assert.equal(
    slugify('Fix chart lag when the window is resized'),
    'fix-chart-lag-when-the-window-is-resized',
  );
  assert.equal(slugify('Chart: lag!! (urgent)'), 'chart-lag-urgent');
  assert.equal(slugify(''), '');
});

test('accented and Vietnamese summaries survive as ASCII', () => {
  assert.equal(slugify('Cập nhật biểu đồ thống kê'), 'cap-nhat-bieu-do-thong-ke');
  assert.equal(slugify('Đăng nhập lỗi'), 'dang-nhap-loi');
});

test('the slug is cut on a word boundary, never mid-word', () => {
  const slug = slugify('alpha beta gamma delta epsilon zeta', 20);
  assert.equal(slug, 'alpha beta gamma'.replace(/ /g, '-'));
  assert.equal(slug.length <= 20, true);
});

test('a summary with no usable characters yields an empty slug', () => {
  assert.equal(slugify('!!! ???'), '');
});

// ------------------------------------------------------------ branch names

test('the issue type picks the conventional prefix', () => {
  assert.equal(typePrefix('Bug'), 'bugfix');
  assert.equal(typePrefix('Story'), 'feature');
  assert.equal(typePrefix('Sub-task'), 'feature');
  assert.equal(typePrefix('Chore'), 'chore');
  assert.equal(typePrefix('Spike'), 'spike');
});

test('renders a branch name from the template', () => {
  const issue = { key: 'TPLD-958', summary: 'Fix chart lag', type: 'Bug' };
  assert.equal(branchNameFor(issue), 'bugfix/TPLD-958-fix-chart-lag');
  assert.equal(branchNameFor(issue, '{key}'), 'TPLD-958');
  assert.equal(branchNameFor(issue, 'sang/{type}/{key}'), 'sang/bug/TPLD-958');
});

test('an unknown placeholder is left visible instead of blanked', () => {
  const name = branchNameFor(
    { key: 'TPLD-1', summary: 'x', type: 'Bug' },
    '{sprint}/{key}',
  );
  assert.equal(name, '{sprint}/TPLD-1');
});

test('an empty template falls back to the default shape', () => {
  assert.equal(
    branchNameFor({ key: 'TPLD-1', summary: 'Fix it', type: 'Bug' }, '   '),
    'bugfix/TPLD-1-fix-it',
  );
});

test('a summary that slugifies to nothing still gives a usable branch', () => {
  assert.equal(
    branchNameFor({ key: 'TPLD-1', summary: '!!!', type: 'Task' }, '{prefix}/{key}-{summary}'),
    'feature/TPLD-1',
  );
});

test('sanitizes what git would refuse', () => {
  assert.equal(sanitizeBranchName('feature/TPLD 1: fix~this^now'), 'feature/TPLD-1-fix-this-now');
  assert.equal(sanitizeBranchName('feature//double///slash'), 'feature/double/slash');
  assert.equal(sanitizeBranchName('.hidden/branch.'), 'hidden/branch');
  assert.equal(sanitizeBranchName('a..b'), 'a.b');
  assert.equal(sanitizeBranchName('feature/x.lock'), 'feature/xlock');
  assert.equal(sanitizeBranchName('-leading-and-trailing-'), 'leading-and-trailing');
  // `@{` is what git refuses; a lone brace is legal, and template placeholders
  // that were not substituted have to survive so the typo stays visible.
  assert.equal(sanitizeBranchName('head@{1}'), 'head-1}');
});

test('isValidBranchName accepts only what needs no rewriting', () => {
  assert.equal(isValidBranchName('feature/TPLD-1-fix'), true);
  assert.equal(isValidBranchName('feature/TPLD 1'), false);
  assert.equal(isValidBranchName(''), false);
  assert.equal(isValidBranchName('   '), false);
});

// ---------------------------------------------------------------- for-each-ref

const REF_OUTPUT = [
  'feature/TPLD-958-chart\trefs/heads/feature/TPLD-958-chart\torigin/feature/TPLD-958-chart\t2026-08-26T10:00:00+07:00\tFix the chart',
  'main\trefs/heads/main\torigin/main\t2026-08-20T10:00:00+07:00\tRelease 2.1.0',
  'origin/feature/TPLD-958-chart\trefs/remotes/origin/feature/TPLD-958-chart\t\t2026-08-26T10:00:00+07:00\tFix the chart',
  'origin/feature/WEB-12-login\trefs/remotes/origin/feature/WEB-12-login\t\t2026-08-25T10:00:00+07:00\tStart login',
  'origin/HEAD\trefs/remotes/origin/HEAD\t\t\t',
  '',
].join('\n');

test('parses local and remote refs, and drops origin/HEAD', () => {
  const branches = parseBranchLines(REF_OUTPUT, 'feature/TPLD-958-chart');
  assert.deepEqual(
    branches.map((branch) => branch.name),
    [
      'feature/TPLD-958-chart',
      'main',
      'origin/feature/TPLD-958-chart',
      'origin/feature/WEB-12-login',
    ],
  );

  const [current, main, remoteSame, remoteOther] = branches;
  assert.equal(current.isCurrent, true);
  assert.equal(current.isRemote, false);
  assert.equal(current.issueKey, 'TPLD-958');
  assert.equal(current.subject, 'Fix the chart');
  assert.equal(main.issueKey, undefined);
  assert.equal(remoteSame.isRemote, true);
  assert.equal(remoteSame.remote, 'origin');
  assert.equal(remoteSame.localName, 'feature/TPLD-958-chart');
  assert.equal(remoteOther.issueKey, 'WEB-12');
  assert.equal(remoteOther.isCurrent, false);
});

// -------------------------------------------------------------------- planning

const BRANCHES = parseBranchLines(REF_OUTPUT, 'main');

test('an existing local branch is switched to, not recreated', () => {
  const plan = planCheckout(BRANCHES, 'TPLD-958', 'bugfix/TPLD-958-new');
  assert.equal(plan.action, 'switch');
  assert.equal(plan.branch, 'feature/TPLD-958-chart');
  assert.equal(plan.alreadyOnBranch, false);
  // The remote branch the local one already tracks is not offered twice.
  assert.deepEqual(
    plan.candidates.map((branch) => branch.name),
    ['feature/TPLD-958-chart'],
  );
});

test('being on the branch already is reported rather than re-run', () => {
  const plan = planCheckout(
    parseBranchLines(REF_OUTPUT, 'feature/TPLD-958-chart'),
    'TPLD-958',
    'ignored',
  );
  assert.equal(plan.alreadyOnBranch, true);
  assert.equal(plan.branch, 'feature/TPLD-958-chart');
});

test('a remote-only branch is tracked under its local name', () => {
  const plan = planCheckout(BRANCHES, 'WEB-12', 'feature/WEB-12-new');
  assert.equal(plan.action, 'track');
  assert.equal(plan.branch, 'feature/WEB-12-login');
  assert.equal(plan.remoteRef, 'origin/feature/WEB-12-login');
});

test('an unknown issue key means a new branch from the suggestion', () => {
  const plan = planCheckout(BRANCHES, 'TPLD-1', 'bugfix/TPLD-1-fix chart');
  assert.equal(plan.action, 'create');
  assert.equal(plan.branch, 'bugfix/TPLD-1-fix-chart');
  assert.deepEqual(plan.candidates, []);
});

test('several matching branches are all offered', () => {
  const refs = [
    'old/TPLD-5-first\trefs/heads/old/TPLD-5-first\t\t2026-01-01T10:00:00+07:00\tOld try',
    'feature/TPLD-5-second\trefs/heads/feature/TPLD-5-second\t\t2026-08-01T10:00:00+07:00\tSecond try',
    'origin/feature/TPLD-5-third\trefs/remotes/origin/feature/TPLD-5-third\t\t2026-08-02T10:00:00+07:00\tTeammate',
  ].join('\n');
  const plan = planCheckout(parseBranchLines(refs, 'main'), 'TPLD-5', 'x');
  assert.equal(plan.candidates.length, 3);
  // Locals first: the branch the developer already has is the safe default.
  assert.equal(plan.candidates[0].isRemote, false);
  assert.equal(plan.candidates[2].isRemote, true);
});
