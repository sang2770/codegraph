import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load.mjs';

const vscode = {
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  commands: { executeCommand: async () => undefined },
};
const { updateDaily, emptyDay, chatSaving, MAX_HISTORY_DAYS } = loadTypeScript('metrics.ts', { vscode });
const {
  buildExecutiveReport,
  DEFAULT_ASSUMPTIONS,
  estimateMinutes,
  groupDays,
  isoWeek,
  renderExecutiveHtml,
  renderExecutiveMarkdown,
} = loadTypeScript('roiReport.ts', { vscode });

const day = (date, fields = {}) => ({ ...emptyDay(date), ...fields });

test('daily history adds to today, rolls over to a new day, and stays bounded', () => {
  let daily = updateDaily(undefined, '2026-10-01', (d) => ({ ...d, analyses: d.analyses + 1 }));
  daily = updateDaily(daily, '2026-10-01', (d) => ({ ...d, analyses: d.analyses + 1 }));
  daily = updateDaily(daily, '2026-10-02', (d) => ({ ...d, analyses: d.analyses + 1 }));
  assert.deepEqual(daily.map((d) => [d.date, d.analyses]), [['2026-10-01', 2], ['2026-10-02', 1]]);

  const long = Array.from({ length: MAX_HISTORY_DAYS + 5 }, (_, i) =>
    day(`2025-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`),
  );
  assert.equal(updateDaily(long, '2099-01-01', (d) => d).length, MAX_HISTORY_DAYS);
});

test('an older day entry missing newer fields is filled in, not turned into NaN', () => {
  const daily = updateDaily([{ date: '2026-10-01', analyses: 1 }], '2026-10-01', (d) => ({
    ...d,
    affectedTestRuns: d.affectedTestRuns + 1,
  }));
  assert.equal(daily[0].affectedTestRuns, 1);
  assert.equal(daily[0].analyses, 1);
});

test('chat savings are like-for-like, and unknown when unmeasured', () => {
  assert.deepEqual(chatSaving({ baselineMeasured: true, baselineTokens: 1000, contextCharacters: 800 }), {
    contextTokens: 200,
    saved: 800,
  });
  assert.equal(chatSaving({ baselineMeasured: false, baselineTokens: 0, contextCharacters: 800 }), undefined);
  assert.equal(chatSaving({ baselineMeasured: true, baselineTokens: 10 }), undefined);
});

test('hours come only from counts times the stated assumptions', () => {
  const minutes = estimateMinutes(
    { chatRequests: { review: 2, impact: 1, fix: 1, explain: 5 }, affectedTestRuns: 3 },
    DEFAULT_ASSUMPTIONS,
  );
  assert.equal(minutes.tests, 3 * 19);
  assert.equal(minutes.review, 3 * 35);
  assert.equal(minutes.fix, 100);
  // Explain has no default figure, so it contributes nothing.
  assert.equal(minutes.explain, 0);
  assert.equal(minutes.total, 57 + 105 + 100);
});

test('ISO weeks follow the Thursday rule across a year boundary', () => {
  assert.equal(isoWeek('2026-10-01'), '2026-W40');
  assert.equal(isoWeek('2021-01-03'), '2020-W53');
  assert.equal(isoWeek('2024-12-30'), '2025-W01');
});

test('groups days into weeks and months and totals impact and chat savings together', () => {
  const daily = [
    day('2026-09-28', { tokensSaved: 100, baselineTokens: 300, contextTokens: 200, chatRequests: { fix: 1 } }),
    day('2026-10-01', { chatTokensSaved: 50, chatBaselineTokens: 100, chatContextTokens: 50 }),
    day('2026-10-05', { affectedTestRuns: 2 }),
  ];
  const weeks = groupDays(daily, 'week', DEFAULT_ASSUMPTIONS);
  assert.deepEqual(weeks.map((w) => [w.label, w.tokensSaved]), [['2026-W40', 150], ['2026-W41', 0]]);
  const months = groupDays(daily, 'month', DEFAULT_ASSUMPTIONS);
  assert.deepEqual(months.map((m) => m.label), ['2026-09', '2026-10']);
  assert.equal(months[1].minutesSaved.tests, 2 * 19);
});

test('the executive report measures savings over the selected period only', () => {
  const snapshot = {
    analyses: 2,
    measuredAnalyses: 2,
    totalLatencyMs: 0,
    totalContextTokens: 0,
    totalBaselineTokens: 0,
    totalTokensSaved: 0,
    totalFileReadsAvoided: 0,
    daily: [
      day('2026-08-01', { analyses: 1, baselineTokens: 1000, contextTokens: 100, tokensSaved: 900 }),
      day('2026-10-01', { analyses: 1, baselineTokens: 400, contextTokens: 100, tokensSaved: 300 }),
    ],
  };
  const report = buildExecutiveReport(snapshot, {
    workspace: 'shop',
    assumptions: DEFAULT_ASSUMPTIONS,
    now: new Date('2026-10-01T10:00:00Z'),
    since: '2026-09-01',
  });
  assert.deepEqual(report.range, { from: '2026-10-01', to: '2026-10-01' });
  assert.equal(report.totals.tokensSaved, 300);
  assert.equal(report.savingsPercent, 75);
  assert.equal(report.legacy, undefined);
});

test('lifetime totals from before daily history are noted, not mixed into trends', () => {
  const report = buildExecutiveReport(
    { analyses: 10, measuredAnalyses: 10, totalLatencyMs: 0, totalContextTokens: 0, totalBaselineTokens: 0, totalTokensSaved: 5000, totalFileReadsAvoided: 40 },
    { workspace: 'shop', assumptions: DEFAULT_ASSUMPTIONS, now: new Date() },
  );
  assert.equal(report.range, undefined);
  assert.deepEqual(report.legacy, { analyses: 10, tokensSaved: 5000, fileReadsAvoided: 40 });
  assert.match(renderExecutiveMarkdown(report, 'en'), /No activity has been recorded yet/);
});

test('renders Markdown and self-contained HTML that label estimates as estimates', () => {
  const report = buildExecutiveReport(
    {
      analyses: 1, measuredAnalyses: 1, totalLatencyMs: 0, totalContextTokens: 0, totalBaselineTokens: 0, totalTokensSaved: 0, totalFileReadsAvoided: 0,
      daily: [day('2026-10-01', { analyses: 1, chatRequests: { review: 2 }, affectedTestRuns: 1, tokensSaved: 1200, baselineTokens: 1500, contextTokens: 300 })],
    },
    { workspace: 'shop <main>', assumptions: DEFAULT_ASSUMPTIONS, now: new Date('2026-10-01T10:00:00Z') },
  );
  const markdown = renderExecutiveMarkdown(report, 'en');
  assert.match(markdown, /# CodeBrain executive ROI report/);
  assert.match(markdown, /\| Review \(\/review, impact\) \| 2 \| 35 \| 1\.2 \|/);
  assert.match(markdown, /codebrain\.roi\.fullSuiteMinutes/);
  assert.match(markdown, /xychart-beta/);

  const html = renderExecutiveHtml(report, 'en');
  assert.match(html, /<svg[^>]+role="img"/);
  assert.match(html, /shop &lt;main&gt;/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /Estimated/);

  assert.match(renderExecutiveMarkdown(report, 'vi'), /Báo cáo hiệu quả/);
});
