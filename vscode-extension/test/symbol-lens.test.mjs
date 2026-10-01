import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const vscode = {
  CodeLens: class {
    constructor(range, command) {
      this.range = range;
      this.command = command;
    }
  },
};
const { collectLensSymbols, parseCallers, parsePorcelain } = loadTypeScript('symbolLens.ts', { vscode });

const KINDS = { function: 11, method: 5 };

test('collects functions and methods from hierarchical and flat symbols, with bare names', () => {
  const symbols = [
    {
      name: 'Cart',
      kind: 4,
      selectionRange: { start: { line: 1 } },
      children: [
        { name: 'total(int)', kind: 5, selectionRange: { start: { line: 3 } } },
        { name: 'items', kind: 7, selectionRange: { start: { line: 2 } } },
      ],
    },
    { name: '(*Cart).Checkout', kind: 5, location: { range: { start: { line: 20 } } } },
    { name: 'helper', kind: 11, range: { start: { line: 30 } } },
    { name: '<anonymous>', kind: 11, range: { start: { line: 40 } } },
  ];
  assert.deepEqual(collectLensSymbols(symbols, KINDS), [
    { name: 'total', line: 3 },
    { name: 'Checkout', line: 20 },
    { name: 'helper', line: 30 },
  ]);
  assert.equal(collectLensSymbols(symbols, KINDS, 1).length, 1);
});

test('reads callers JSON and treats a not-found notice as no callers', () => {
  assert.deepEqual(
    parseCallers('{"symbol":"total","callers":[{"name":"checkout","kind":"function","filePath":"src/a.ts","startLine":4},{"bad":1}]}'),
    [{ name: 'checkout', kind: 'function', filePath: 'src/a.ts', startLine: 4 }],
  );
  assert.deepEqual(parseCallers('Symbol "total" not found'), []);
});

test('reads changed paths, including renames and quoted names, from git status', () => {
  assert.deepEqual(parsePorcelain(' M src/a.ts\n?? new file.ts\nR  old.ts -> src/b.ts\n M "src/c d.ts"\n'), [
    'src/a.ts',
    'new file.ts',
    'src/b.ts',
    'src/c d.ts',
  ]);
});
