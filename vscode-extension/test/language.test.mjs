import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const { detectResponseLanguage, detectConversationLanguage, responseLanguageInstruction } =
  loadTypeScript('language.ts');

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

test('keeps one conversation in one language when a follow-up carries no signal', () => {
  // "more detail" has no language marker; without the earlier turns the report
  // would silently switch to the VS Code display language mid-thread.
  assert.equal(
    detectConversationLanguage(
      ['Giải thích workflow đăng nhập này', 'more detail'],
      'en',
    ).code,
    'vi',
  );
});

test('follows the most recent turn that did carry a language signal', () => {
  assert.equal(
    detectConversationLanguage(
      ['Giải thích workflow này', 'Now explain how the review workflow works', 'ok'],
      'vi',
    ).code,
    'en',
  );
});

test('falls back to the VS Code language when no turn carries a signal', () => {
  const language = detectConversationLanguage(['refreshSession', 'x'], 'ko');
  assert.equal(language.code, 'ko');
  assert.equal(language.source, 'vscode');
});
