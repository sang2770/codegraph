import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/language.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, {
  exports: module.exports,
  module,
  require,
});

const { detectResponseLanguage, responseLanguageInstruction } = module.exports;

test('detects Vietnamese with accents', () => {
  assert.equal(
    detectResponseLanguage('Giải thích workflow này dùng để làm gì?', 'en').code,
    'vi',
  );
});

test('detects Vietnamese without accents', () => {
  assert.equal(
    detectResponseLanguage('giai thich cai nay hoat dong nhu the nao', 'en').code,
    'vi',
  );
});

test('detects English and major writing systems', () => {
  assert.equal(detectResponseLanguage('How does this workflow work?', 'vi').code, 'en');
  assert.equal(detectResponseLanguage('この処理を説明してください', 'en').code, 'ja');
  assert.equal(detectResponseLanguage('이 흐름을 설명해 주세요', 'en').code, 'ko');
  assert.equal(detectResponseLanguage('解释这个工作流程', 'en').code, 'zh');
});

test('falls back to the VS Code locale for symbol-only prompts', () => {
  assert.equal(detectResponseLanguage('loadUser()', 'vi-VN').code, 'vi');
  assert.equal(detectResponseLanguage('', 'fr-FR').code, 'fr');
});

test('builds an explicit whole-report language constraint', () => {
  const language = detectResponseLanguage('Giải thích code này', 'en');
  const instruction = responseLanguageInstruction(language);
  assert.match(instruction, /entire report in Vietnamese/);
  assert.match(instruction, /diagram label/);
});
