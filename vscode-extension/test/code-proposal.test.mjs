import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadTypeScript } from './helpers/load.mjs';

const { parseCodeProposals, applyProposal, resolveProposalPath, parseSearchReplace } =
  loadTypeScript('codeProposal.ts');

const fence = '```';

test('reads whole-file and SEARCH/REPLACE proposals from fenced blocks that name a file', () => {
  const report = [
    '# Bug analysis',
    '## Code proposal',
    `${fence}ts file=src/cart.ts`,
    '<<<<<<< SEARCH',
    '  return items.reduce((sum, item) => sum + item.price, 0);',
    '=======',
    '  return (items ?? []).reduce((sum, item) => sum + item.price, 0);',
    '>>>>>>> REPLACE',
    fence,
    '',
    `${fence}ts file="test/cart.test.ts"`,
    "import { total } from '../src/cart';",
    fence,
    '## Handoff prompt',
    `${fence}text`,
    'Apply the fix.',
    fence,
    `${fence}mermaid`,
    'flowchart LR',
    fence,
  ].join('\n');

  const proposals = parseCodeProposals(report);
  assert.equal(proposals.length, 2);
  assert.deepEqual(proposals[0], {
    path: 'src/cart.ts',
    language: 'ts',
    edits: [
      {
        search: '  return items.reduce((sum, item) => sum + item.price, 0);',
        replace: '  return (items ?? []).reduce((sum, item) => sum + item.price, 0);',
      },
    ],
  });
  assert.equal(proposals[1].path, 'test/cart.test.ts');
  assert.equal(proposals[1].content, "import { total } from '../src/cart';\n");
});

test('accepts a File: label above the block, and keeps the last block for a file', () => {
  const report = [
    '**File:** `src/a.ts`',
    `${fence}ts`,
    'first',
    fence,
    `${fence}ts file=src/a.ts`,
    'second',
    fence,
  ].join('\n');
  const proposals = parseCodeProposals(report);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].content, 'second\n');
});

test('ignores snippets without a file and voids an unterminated edit', () => {
  assert.deepEqual(parseCodeProposals(`${fence}ts\nconst x = 1;\n${fence}`), []);
  assert.deepEqual(parseSearchReplace('<<<<<<< SEARCH\na\n=======\nb'), []);
  const truncated = `${fence}ts file=src/a.ts\n<<<<<<< SEARCH\na\n=======\nb\n${fence}`;
  assert.deepEqual(parseCodeProposals(truncated), []);
});

test('applies each edit exactly once, preserving CRLF line endings', () => {
  const proposal = {
    path: 'a.ts',
    language: 'ts',
    edits: [
      { search: 'const a = 1;', replace: 'const a = 2;' },
      { search: 'const b = 1;', replace: 'const b = 3;' },
    ],
  };
  const result = applyProposal('const a = 1;\r\nconst b = 1;\r\n', proposal);
  assert.deepEqual(result, { ok: true, text: 'const a = 2;\r\nconst b = 3;\r\n', created: false });
});

test('refuses an edit whose SEARCH is missing or ambiguous', () => {
  const missing = applyProposal('x\n', { path: 'a.ts', language: '', edits: [{ search: 'y', replace: 'z' }] });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not found/);
  const twice = applyProposal('y\ny\n', { path: 'a.ts', language: '', edits: [{ search: 'y', replace: 'z' }] });
  assert.equal(twice.ok, false);
  assert.match(twice.error, /2 times/);
});

test('matches a SEARCH that differs only in trailing whitespace', () => {
  const result = applyProposal('if (a) {   \n  run();\n}\n', {
    path: 'a.ts',
    language: '',
    edits: [{ search: 'if (a) {\n  run();', replace: 'if (a && b) {\n  run();' }],
  });
  assert.deepEqual(result, { ok: true, text: 'if (a && b) {\n  run();\n}\n', created: false });
});

test('creates a new file from full content or an empty SEARCH, never from a non-empty one', () => {
  assert.deepEqual(applyProposal(undefined, { path: 'n.ts', language: '', content: 'x\n' }), {
    ok: true,
    text: 'x\n',
    created: true,
  });
  assert.equal(
    applyProposal(undefined, { path: 'n.ts', language: '', edits: [{ search: '', replace: 'x' }] }).ok,
    true,
  );
  assert.equal(
    applyProposal(undefined, { path: 'n.ts', language: '', edits: [{ search: 'y', replace: 'x' }] }).ok,
    false,
  );
});

test('only writes inside the project and never into git, index or dependency folders', () => {
  const root = join('/work', 'project');
  assert.deepEqual(resolveProposalPath(root, 'src/a.ts'), { ok: true, absolute: join(root, 'src', 'a.ts') });
  for (const path of ['../other/a.ts', '/etc/passwd', 'src/../../a.ts', '.git/config', '.codegraph/x', 'node_modules/a/index.js', '']) {
    assert.equal(resolveProposalPath(root, path).ok, false, path);
  }
});
