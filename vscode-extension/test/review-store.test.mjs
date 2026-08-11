import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const { parseReviewFindings, findingId, resolveAnchor } =
  loadTypeScript('reviewStore.ts');

test('parses marker findings with severity, file, and line', () => {
  const findings = parseReviewFindings(
    [
      '## Findings',
      '<!-- codebrain-finding severity="high" file="src/auth.ts" line="42" -->',
      '**Impact:** The session can outlive its token.',
      '**Recommendation:** Clear the cache on refresh failure.',
      '<!-- codebrain-finding severity="low" file="src/util.ts" line="7" -->',
      '**Impact:** Dead branch.',
    ].join('\n'),
  );

  assert.equal(findings.length, 2);
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[0].file, 'src/auth.ts');
  assert.equal(findings[0].line, 42);
  assert.match(findings[0].body, /session can outlive/);
  assert.equal(findings[1].severity, 'low');
});

test('falls back to prose findings when the model omits markers', () => {
  const findings = parseReviewFindings(
    '- **CRITICAL** — `src/payment.ts`:118 unchecked amount\n',
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'critical');
  assert.equal(findings[0].file, 'src/payment.ts');
  assert.equal(findings[0].line, 118);
});

test('a finding keeps its identity when unrelated code shifts its line', () => {
  const base = {
    file: 'src/auth.ts',
    severity: 'high',
    anchorText: 'const token = refresh();',
    body: '**Impact:** The session can outlive its token.',
  };

  // Same finding, reported at a different line after an edit above it.
  assert.equal(findingId(base), findingId({ ...base }));
  // A different finding on the same line is a different identity.
  assert.notEqual(
    findingId(base),
    findingId({ ...base, anchorText: 'const user = load();' }),
  );
  assert.notEqual(findingId(base), findingId({ ...base, severity: 'low' }));
});

test('follows an anchor that moved after lines were inserted above it', () => {
  const lines = [
    '// new header',
    '// new header',
    '// new header',
    'function refresh() {',
    '  const token = refresh();',
    '}',
  ];

  const anchor = resolveAnchor(lines, 2, 'const token = refresh();');

  assert.equal(anchor.line, 5);
  assert.equal(anchor.drifted, true);
  assert.equal(anchor.lost, false);
});

test('stays put when the anchor is already correct', () => {
  const lines = ['a', 'const token = refresh();', 'b'];

  const anchor = resolveAnchor(lines, 2, 'const token = refresh();');

  assert.equal(anchor.line, 2);
  assert.equal(anchor.drifted, false);
});

test('admits when the reviewed line is gone instead of pointing at other code', () => {
  const lines = ['a', 'b', 'c'];

  const anchor = resolveAnchor(lines, 2, 'const token = refresh();');

  assert.equal(anchor.lost, true);
  assert.equal(anchor.drifted, false);
});

test('clamps a stale line number to the end of a shortened file', () => {
  const anchor = resolveAnchor(['only line'], 400, 'gone');

  assert.equal(anchor.line, 1);
  assert.equal(anchor.lost, true);
});
