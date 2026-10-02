import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const { buildReviewPlan, groupFiles, ruleIdsFor, splitDiffByFile, renderRules } = loadTypeScript('reviewPlan.ts');
const { parseReviewFindings, relocateByCode } = loadTypeScript('reviewStore.ts');

const diffOf = (path, body = '+x') =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}`;

test('splits a diff per file', () => {
  const chunks = splitDiffByFile(`${diffOf('a.ts')}\n${diffOf('b/c.go')}`);
  assert.deepEqual([...chunks.keys()], ['a.ts', 'b/c.go']);
  assert.match(chunks.get('b/c.go'), /^diff --git a\/b\/c\.go/);
});

test('filters noise with a reason and flags files that have no diff', () => {
  const plan = buildReviewPlan(
    ['package-lock.json', 'src/a.ts', 'dist/x.js', 'new.ts'],
    diffOf('src/a.ts'),
    10_000,
  );
  assert.deepEqual(plan.batches.map((b) => b.files), [['src/a.ts']]);
  assert.deepEqual(plan.excluded.map((e) => e.reason), ['lockfile', 'vendored or build output']);
  assert.deepEqual(plan.missingDiff, ['new.ts']);
});

test('picks rules by file type', () => {
  assert.deepEqual(ruleIdsFor('src/a.go'), ['go']);
  assert.deepEqual(ruleIdsFor('src/a.test.ts'), ['ts-js', 'test']);
  assert.deepEqual(ruleIdsFor('README.md'), ['default']);
  assert.match(renderRules(['a.go']), /goroutine leaks/);
});

test('bundles related files and caps group size', () => {
  const groups = groupFiles(['src/a.ts', 'src/a.test.ts', 'i18n/m_en.properties', 'i18n/m_zh.properties']);
  assert.deepEqual(groups.map((g) => g.label), ['i18n', 'src']);
  assert.equal(groups[1].files.length, 2);
  const many = groupFiles(Array.from({ length: 23 }, (_, i) => `d/f${i}.ts`));
  assert.deepEqual(many.map((g) => g.files.length), [10, 10, 3]);
});

test('packs groups into batches under the budget and never drops a file', () => {
  const files = ['a/1.ts', 'a/2.ts', 'b/1.ts', 'c/1.ts'];
  const diff = files.map((f) => diffOf(f, '+'.padEnd(400, 'x'))).join('\n');
  const plan = buildReviewPlan(files, diff, 1000);
  assert.ok(plan.batches.length > 1);
  assert.deepEqual(plan.batches.flatMap((b) => b.files).sort(), [...files].sort());
  for (const batch of plan.batches) assert.ok(batch.diff.length <= 1000 + 60);
});

test('relocates a miscounted line from the quoted code', () => {
  const lines = ['a', '  foo(a);', '  bar();', 'b', '  foo(a);'];
  assert.deepEqual(relocateByCode(lines, 'foo(a);', 2), { line: 2, moved: false, found: true });
  assert.deepEqual(relocateByCode(lines, 'foo(a);\nbar();', 5), { line: 2, moved: true, found: true });
  assert.deepEqual(relocateByCode(lines, 'foo(a);', 40), { line: 5, moved: true, found: true });
  assert.deepEqual(relocateByCode(lines, 'nope', 3), { line: 3, moved: false, found: false });
});

test('parses the optional code attribute, including inner quotes', () => {
  const [a, b] = parseReviewFindings(
    [
      '<!-- codebrain-finding severity="high" file="a.ts" line="9" code="const s = "x";" -->',
      '**Impact:** i',
      '<!-- codebrain-finding severity="low" file="b.ts" line="3" -->',
      '**Impact:** j',
    ].join('\n'),
  );
  assert.equal(a.code, 'const s = "x";');
  assert.equal(a.line, 9);
  assert.equal(b.code, undefined);
});

const { dedupeFindings, formatFinding } = loadTypeScript('reviewStore.ts');
const { fitDiffToBudget, coverageNote, estimateReviewCost } = loadTypeScript('reviewPlan.ts');

test('parser tolerates attribute order, quotes, aliases, ranges and L-prefixed lines', () => {
  const found = parseReviewFindings(
    [
      "<!-- codebrain-finding file='./src/a.ts' severity=Major line=L42-45 -->",
      'one',
      '<!--codebrain-finding severity="nit" line="7" file="`b.ts`" code="x = "y";"-->',
      'two',
      '<!-- codebrain-finding severity="bogus" file="c.ts" line="1" -->',
      'dropped: unknown severity',
    ].join('\n'),
  );
  assert.equal(found.length, 2);
  assert.deepEqual([found[0].severity, found[0].file, found[0].line], ['high', 'src/a.ts', 42]);
  assert.deepEqual([found[1].severity, found[1].file, found[1].line, found[1].code], ['low', 'b.ts', 7, 'x = "y";']);
});

test('formatFinding round-trips through the parser', () => {
  const finding = { severity: 'high', file: 'a.ts', line: 3, code: 'f("x")', body: '**Impact:** boom' };
  assert.deepEqual(parseReviewFindings(formatFinding(finding)), [finding]);
});

test('dedupe merges repeats within a few lines, keeping the higher severity', () => {
  const kept = dedupeFindings([
    { severity: 'medium', file: 'a.ts', line: 10, body: 'Null deref when the session token is missing' },
    { severity: 'high', file: 'a.ts', line: 12, body: 'The session token may be missing, causing a null deref' },
    { severity: 'high', file: 'a.ts', line: 90, body: 'Null deref when the session token is missing' },
    { severity: 'high', file: 'b.ts', line: 10, body: 'Null deref when the session token is missing' },
    { severity: 'low', file: 'a.ts', line: 11, body: 'Rename this variable for clarity please' },
  ]);
  assert.deepEqual(kept.map((f) => [f.file, f.line, f.severity]), [['a.ts', 12, 'high'], ['a.ts', 90, 'high'], ['b.ts', 10, 'high'], ['a.ts', 11, 'low']]);
});

test('fitDiffToBudget keeps whole files and reports what it left out', () => {
  const files = ['a.ts', 'big.ts', 'yarn.lock', 'c.ts', 'new.ts'];
  const diff = [diffOf('a.ts', '+'.padEnd(100, 'a')), diffOf('big.ts', '+'.padEnd(900, 'b')), diffOf('yarn.lock'), diffOf('c.ts', '+'.padEnd(100, 'c'))].join('\n');
  const fit = fitDiffToBudget(files, diff, 500);
  assert.deepEqual(fit.included, ['a.ts', 'c.ts']);
  assert.deepEqual(fit.overBudget, ['big.ts']);
  assert.deepEqual(fit.excluded, [{ path: 'yarn.lock', reason: 'lockfile' }]);
  assert.deepEqual(fit.missingDiff, ['new.ts']);
  assert.ok(!fit.diff.includes('big.ts'));
  const note = coverageNote(fit);
  assert.match(note, /do NOT claim these were reviewed:\n- big\.ts/);
  assert.equal(coverageNote({ overBudget: [], excluded: [], missingDiff: [] }), '');
});

test('estimates one request per batch', () => {
  const est = estimateReviewCost({ batches: [{ diff: 'x'.repeat(4000) }, { diff: '' }] });
  assert.equal(est.requests, 2);
  assert.equal(est.inputTokens, Math.ceil((4000 + 8000 + 8000) / 4));
});

const { collectCoveredReviewContext } = loadTypeScript('reviewDiff.ts');

test('re-reads a truncated diff with headroom, filters noise and records coverage', async () => {
  const calls = [];
  const full = [diffOf('a.ts'), diffOf('yarn.lock'), diffOf('z.ts', '+'.padEnd(800, 'z'))].join('\n');
  const context = await collectCoveredReviewContext(async (limit) => {
    calls.push(limit);
    return { isRepository: true, status: '', stat: '', changedFiles: ['a.ts', 'yarn.lock', 'z.ts'], diff: limit > 1000 ? full : full.slice(0, 100), truncated: limit <= 1000 };
  }, 600);
  assert.deepEqual(calls, [600, 2400]);
  assert.match(context.diff, /a\.ts/);
  assert.ok(!context.diff.includes('yarn.lock'));
  assert.equal(context.truncated, true);
  assert.match(context.coverageNote, /- z\.ts/);
  assert.match(context.coverageNote, /yarn\.lock: lockfile/);
});

const { extractSuggestion, buildSuggestionReplacement, filterFindingBlocks } = loadTypeScript('reviewStore.ts');
const { buildVerifyPrompt, parseVerifyReply } = loadTypeScript('reviewVerify.ts');
const { renderPlanMarkdown } = loadTypeScript('reviewPlan.ts');

test('extracts a suggestion block and re-indents it to the flagged line', () => {
  const body = '**Impact:** x\n```suggestion\nif (a) {\n  b();\n}\n```';
  assert.equal(extractSuggestion(body), 'if (a) {\n  b();\n}');
  assert.equal(extractSuggestion('no fence here'), undefined);
  assert.equal(buildSuggestionReplacement(['    foo(a);'], 'if (a) {\n  b();\n}'), '    if (a) {\n      b();\n    }');
  assert.equal(buildSuggestionReplacement(['\tx = 1;'], 'x = 1;'), undefined, 'identical suggestion is not offered');
  assert.equal(buildSuggestionReplacement(['x'], '  \n '), undefined);
});

test('filterFindingBlocks removes only the rejected blocks', () => {
  const md = '# R\n<!-- codebrain-finding severity="high" file="a.ts" line="1" -->\nA\n<!-- codebrain-finding severity="low" file="b.ts" line="2" -->\nB';
  const out = filterFindingBlocks(md, (f) => f.file !== 'a.ts');
  assert.ok(!out.includes('\nA'));
  assert.match(out, /file="b\.ts"[\s\S]*B/);
  assert.match(out, /^# R/);
});

test('verify prompt demands proof and parse never drops on a bad reply', () => {
  const prompt = buildVerifyPrompt([{ severity: 'high', file: 'a.ts', line: 3, body: 'bad\n```suggestion\nx\n```' }], 'DIFF');
  assert.match(prompt, /PROVES/);
  assert.match(prompt, /1\. \[high\] a\.ts:3/);
  assert.ok(!prompt.includes('suggestion\nx'));
  assert.deepEqual(parseVerifyReply('Sure! [{"id": 2, "reason": "diff shows the check"}, {"id": 9, "reason": "x"}, {"id": 1}]', 3), [{ index: 1, reason: 'diff shows the check' }]);
  assert.deepEqual(parseVerifyReply('I think none', 3), []);
  assert.deepEqual(parseVerifyReply('[not json', 3), []);
});

test('renders the plan as markdown for an agent', () => {
  const plan = buildReviewPlan(['a.go', 'yarn.lock', 'n.go'], diffOf('a.go'), 10_000);
  const md = renderPlanMarkdown(plan);
  assert.match(md, /1 file\(s\) in 1 batch\(es\); 1 filtered/);
  assert.match(md, /## Batch 1: \(repo root\)\n- a\.go \(go\)/);
  assert.match(md, /yarn\.lock: lockfile/);
  assert.match(md, /- n\.go/);
  assert.match(md, /goroutine leaks/);
});

const { isInterviewReply, wantsNoInterview, interviewMode, interviewInstructions, INTERVIEW_MARKER } = loadTypeScript('interview.ts');

test('recognises an interview reply by its marker, whatever language the heading is in', () => {
  assert.equal(isInterviewReply(`${INTERVIEW_MARKER}\n# Trước khi lập kế hoạch\n1. ...`), true);
  assert.equal(isInterviewReply(`\n  ${INTERVIEW_MARKER}\n# Before I plan`), true);
  assert.equal(isInterviewReply('# Implementation plan: x\n## Goal'), false);
  assert.equal(isInterviewReply(`# Implementation plan\n${'x'.repeat(400)}\n${INTERVIEW_MARKER}`), false);
});

test('the user can skip the interview in English or Vietnamese', () => {
  for (const prompt of ['add export, no questions', 'just plan it', 'use the recommendations', 'thêm export, không cần hỏi', 'đừng hỏi, làm luôn', 'dùng mặc định']) {
    assert.equal(wantsNoInterview(prompt), true, prompt);
  }
  for (const prompt of ['add an export button to the report', 'thêm nút export vào báo cáo']) {
    assert.equal(wantsNoInterview(prompt), false, prompt);
  }
});

test('interview mode follows the setting and the thread state, and never loops', () => {
  const base = { setting: 'auto', prompt: 'add export', previousWasInterview: false };
  assert.equal(interviewMode(base), 'ask');
  assert.equal(interviewMode({ ...base, setting: undefined }), 'ask');
  assert.equal(interviewMode({ ...base, setting: 'off' }), 'off');
  assert.equal(interviewMode({ ...base, prompt: 'add export, no questions' }), 'off');
  assert.equal(interviewMode({ ...base, previousWasInterview: true }), 'answered');
  assert.equal(interviewMode({ ...base, previousWasInterview: true, setting: 'off' }), 'answered');
});

test('interview instructions: ask carries the marker and limits, answered forbids another round', () => {
  assert.match(interviewInstructions('ask'), new RegExp(INTERVIEW_MARKER));
  assert.match(interviewInstructions('ask'), /at most 5 numbered questions/);
  assert.match(interviewInstructions('answered'), /Do NOT interview again/);
  assert.equal(interviewInstructions('off'), '');
});
