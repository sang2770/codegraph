import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const { extractAcceptanceCriteria, extractCodeHints, extractConfluencePageIds } =
  loadTypeScript('atlassian/taskContext.ts');

test('criteria under a Markdown heading stop at the next heading', () => {
  const text = [
    'Intro.',
    '## Acceptance Criteria',
    '- User can reset the password',
    '- [x] Link expires after 30 minutes',
    '## Notes',
    '- not a criterion',
  ].join('\n');
  assert.deepEqual(extractAcceptanceCriteria(text), [
    'User can reset the password',
    'Link expires after 30 minutes',
  ]);
});

test('Jira wiki numbered items and a bold heading are recognised', () => {
  const text = ['*Acceptance criteria*', '# First', '# Second', '', 'Other prose.'].join('\n');
  assert.deepEqual(extractAcceptanceCriteria(text), ['First', 'Second']);
});

test('Vietnamese headings and an inline criterion are recognised', () => {
  assert.deepEqual(
    extractAcceptanceCriteria('Tiêu chí chấp nhận:\n1. Gửi email trong 1 phút\n2) Link hết hạn sau 30 phút'),
    ['Gửi email trong 1 phút', 'Link hết hạn sau 30 phút'],
  );
  assert.deepEqual(extractAcceptanceCriteria('AC: the export button is disabled while running'), [
    'the export button is disabled while running',
  ]);
});

test('Given/When/Then lines are used when there is no heading', () => {
  const text = 'Given a logged-in user\nWhen they click export\nThen a PDF downloads\nSome prose.';
  assert.deepEqual(extractAcceptanceCriteria(text), [
    'Given a logged-in user',
    'When they click export',
    'Then a PDF downloads',
  ]);
});

test('no criteria means an empty list, not a guess', () => {
  assert.deepEqual(extractAcceptanceCriteria('Make the logs quieter, please.'), []);
});

test('linked Confluence page ids are found in both URL shapes, once each', () => {
  const text =
    'See https://collab/pages/viewpage.action?pageId=123 and https://x.atlassian.net/wiki/spaces/A/pages/456/Title and pageId=123 again.';
  assert.deepEqual(extractConfluencePageIds(text), ['123', '456']);
});

test('code hints come most-specific first and skip URLs, issue keys and prose', () => {
  const hints = extractCodeHints(
    [
      'Call `OrderService.submit` from src/api/orders.ts via {{PaymentGateway}}.',
      'Then refreshCache() runs; see ABC-123 and https://example.com/FooBar.',
      'The retry_policy and InvoiceBuilder matter. JSON and API are not symbols.',
      'Run `npm run test:unit -- orderStore` first.',
    ].join('\n'),
  );
  assert.deepEqual(hints.slice(0, 4), [
    'OrderService.submit',
    'PaymentGateway',
    'orderStore',
    'src/api/orders.ts',
  ]);
  assert.ok(hints.includes('refreshCache'));
  assert.ok(hints.includes('retry_policy'));
  assert.ok(hints.includes('InvoiceBuilder'));
  for (const noise of ['ABC-123', 'FooBar', 'JSON', 'API', 'npm']) {
    assert.ok(!hints.includes(noise), `${noise} is not a code hint`);
  }
});
