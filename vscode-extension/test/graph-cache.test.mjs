import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const { GraphCache } = loadTypeScript('graphCache.ts');
const { parseIndexProgress } = loadTypeScript('indexProgress.ts');

const KEY = { root: '/repo', kind: 'explore', parts: ['how does auth work', 12] };

test('returns a cached answer for the same question at the same generation', () => {
  const cache = new GraphCache();
  cache.set(KEY, 3, 'graph output');

  assert.equal(cache.get(KEY, 3), 'graph output');
});

test('drops the entry once the project content changes', () => {
  const cache = new GraphCache();
  cache.set(KEY, 3, 'graph output');

  // A generation bump means a file changed, so the old answer may be wrong.
  assert.equal(cache.get(KEY, 4), undefined);
  assert.equal(cache.size, 0);
});

test('treats a different query or file budget as a different question', () => {
  const cache = new GraphCache();
  cache.set(KEY, 1, 'graph output');

  assert.equal(cache.get({ ...KEY, parts: ['other question', 12] }, 1), undefined);
  assert.equal(cache.get({ ...KEY, parts: ['how does auth work', 30] }, 1), undefined);
  assert.equal(cache.get({ ...KEY, root: '/other' }, 1), undefined);
});

test('bounds memory by evicting the least recently used entry', () => {
  const cache = new GraphCache();
  for (let index = 0; index < 200; index += 1) {
    cache.set({ root: '/repo', kind: 'explore', parts: [index] }, 1, `v${index}`);
  }

  assert.ok(cache.size <= 64, `expected a bounded cache, got ${cache.size}`);
  assert.equal(cache.get({ root: '/repo', kind: 'explore', parts: [199] }, 1), 'v199');
  assert.equal(cache.get({ root: '/repo', kind: 'explore', parts: [0] }, 1), undefined);
});

test('reads a file ratio out of indexer output', () => {
  const progress = parseIndexProgress('Indexing 1,200/4,800 files\n');

  assert.equal(progress.percent, 25);
  assert.match(progress.message, /1,200 of 4,800 files indexed/);
});

test('reads a bare percentage', () => {
  assert.equal(parseIndexProgress('Resolving references 60%').percent, 60);
});

test('reports a phase line that carries no number', () => {
  const progress = parseIndexProgress('Resolving references…');

  assert.equal(progress.percent, undefined);
  assert.match(progress.message, /Resolving references/);
});

test('produces no update rather than a wrong one for unrecognised output', () => {
  assert.equal(parseIndexProgress('warning: something happened'), undefined);
  assert.equal(parseIndexProgress(''), undefined);
  // A nonsensical ratio must not become a bogus percentage.
  assert.equal(parseIndexProgress('9999/10 files'), undefined);
});
