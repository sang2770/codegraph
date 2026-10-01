import type { ChatCommand, DailyMetrics, TokenSavingSnapshot } from './metrics';
import { emptyDay } from './metrics';

/**
 * Minutes a developer is assumed to save per activity.
 *
 * These are the only non-measured inputs to the report. They are settings
 * (`codebrain.roi.*`), printed in the report next to every hour figure, so a
 * reader can see exactly what an "hours saved" number rests on and change it.
 */
export interface RoiAssumptions {
  /** Full test suite, minutes per run. */
  fullSuiteMinutes: number;
  /** Affected-tests-only run, minutes per run. */
  affectedTestMinutes: number;
  minutesSavedPerReview: number;
  minutesSavedPerFix: number;
  minutesSavedPerExplain: number;
  minutesSavedPerImplement: number;
  minutesSavedPerTest: number;
  minutesSavedPerPr: number;
}

export const DEFAULT_ASSUMPTIONS: RoiAssumptions = {
  fullSuiteMinutes: 20,
  affectedTestMinutes: 1,
  minutesSavedPerReview: 35,
  minutesSavedPerFix: 100,
  minutesSavedPerExplain: 0,
  minutesSavedPerImplement: 0,
  minutesSavedPerTest: 0,
  minutesSavedPerPr: 0,
};

export interface PeriodTotals {
  /** `YYYY-Www` for weeks, `YYYY-MM` for months. */
  label: string;
  /** First calendar day in the period that has data. */
  firstDay: string;
  analyses: number;
  chatRequests: Partial<Record<ChatCommand, number>>;
  chatTotal: number;
  /** Measured (impact + chat) token totals, like-for-like. */
  contextTokens: number;
  baselineTokens: number;
  tokensSaved: number;
  fileReadsAvoided: number;
  chatInputTokens: number;
  chatOutputTokens: number;
  affectedTestRuns: number;
  affectedTestFiles: number;
  proposalsApplied: number;
  proposalFiles: number;
  /** Estimated, from {@link RoiAssumptions}. */
  minutesSaved: MinutesBreakdown;
}

export interface MinutesBreakdown {
  tests: number;
  review: number;
  fix: number;
  explain: number;
  implement: number;
  test: number;
  pr: number;
  total: number;
}

function addCounts(
  a: Partial<Record<ChatCommand, number>>,
  b: Partial<Record<ChatCommand, number>>,
): Partial<Record<ChatCommand, number>> {
  const result = { ...a };
  for (const [key, value] of Object.entries(b) as Array<[ChatCommand, number]>) {
    result[key] = (result[key] ?? 0) + value;
  }
  return result;
}

/** `/impact` folded into `/review`; the guide format is part of `/explain`. */
function chatCount(counts: Partial<Record<ChatCommand, number>>, ...commands: ChatCommand[]): number {
  return commands.reduce((sum, command) => sum + (counts[command] ?? 0), 0);
}

export function estimateMinutes(
  totals: Pick<PeriodTotals, 'chatRequests' | 'affectedTestRuns'>,
  assumptions: RoiAssumptions,
): MinutesBreakdown {
  const perTestRun = Math.max(0, assumptions.fullSuiteMinutes - assumptions.affectedTestMinutes);
  const counts = totals.chatRequests;
  const breakdown = {
    tests: totals.affectedTestRuns * perTestRun,
    review: chatCount(counts, 'review', 'impact') * assumptions.minutesSavedPerReview,
    fix: chatCount(counts, 'fix') * assumptions.minutesSavedPerFix,
    explain: chatCount(counts, 'explain', 'guide') * assumptions.minutesSavedPerExplain,
    implement: chatCount(counts, 'implement') * assumptions.minutesSavedPerImplement,
    test: chatCount(counts, 'test') * assumptions.minutesSavedPerTest,
    pr: chatCount(counts, 'pr') * assumptions.minutesSavedPerPr,
  };
  return {
    ...breakdown,
    total: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
  };
}

/** ISO-8601 week label (`2026-W40`) for a `YYYY-MM-DD` day. */
export function isoWeek(day: string): string {
  const [year, month, date] = day.split('-').map((part) => Number.parseInt(part, 10));
  const utc = new Date(Date.UTC(year!, month! - 1, date!));
  const weekday = utc.getUTCDay() || 7;
  // The ISO week belongs to the year of its Thursday.
  utc.setUTCDate(utc.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function sumDays(label: string, days: readonly DailyMetrics[], assumptions: RoiAssumptions): PeriodTotals {
  const total = days.reduce<DailyMetrics>((sum, raw) => {
    const day = { ...emptyDay(raw.date), ...raw };
    return {
      ...sum,
      analyses: sum.analyses + day.analyses,
      measuredAnalyses: sum.measuredAnalyses + day.measuredAnalyses,
      contextTokens: sum.contextTokens + day.contextTokens,
      baselineTokens: sum.baselineTokens + day.baselineTokens,
      tokensSaved: sum.tokensSaved + day.tokensSaved,
      fileReadsAvoided: sum.fileReadsAvoided + day.fileReadsAvoided,
      chatRequests: addCounts(sum.chatRequests, day.chatRequests),
      chatInputTokens: sum.chatInputTokens + day.chatInputTokens,
      chatOutputTokens: sum.chatOutputTokens + day.chatOutputTokens,
      chatMeasured: sum.chatMeasured + day.chatMeasured,
      chatContextTokens: sum.chatContextTokens + day.chatContextTokens,
      chatBaselineTokens: sum.chatBaselineTokens + day.chatBaselineTokens,
      chatTokensSaved: sum.chatTokensSaved + day.chatTokensSaved,
      affectedTestRuns: sum.affectedTestRuns + day.affectedTestRuns,
      affectedTestFiles: sum.affectedTestFiles + day.affectedTestFiles,
      proposalsApplied: sum.proposalsApplied + day.proposalsApplied,
      proposalFiles: sum.proposalFiles + day.proposalFiles,
    };
  }, emptyDay(days[0]?.date ?? ''));
  const partial = {
    chatRequests: total.chatRequests,
    affectedTestRuns: total.affectedTestRuns,
  };
  return {
    label,
    firstDay: days[0]?.date ?? '',
    analyses: total.analyses,
    chatRequests: total.chatRequests,
    chatTotal: Object.values(total.chatRequests).reduce((sum, value) => sum + (value ?? 0), 0),
    contextTokens: total.contextTokens + total.chatContextTokens,
    baselineTokens: total.baselineTokens + total.chatBaselineTokens,
    tokensSaved: total.tokensSaved + total.chatTokensSaved,
    fileReadsAvoided: total.fileReadsAvoided,
    chatInputTokens: total.chatInputTokens,
    chatOutputTokens: total.chatOutputTokens,
    affectedTestRuns: total.affectedTestRuns,
    affectedTestFiles: total.affectedTestFiles,
    proposalsApplied: total.proposalsApplied,
    proposalFiles: total.proposalFiles,
    minutesSaved: estimateMinutes(partial, assumptions),
  };
}

/** Days grouped into weeks or months, oldest first. */
export function groupDays(
  daily: readonly DailyMetrics[],
  by: 'week' | 'month',
  assumptions: RoiAssumptions,
): PeriodTotals[] {
  const groups = new Map<string, DailyMetrics[]>();
  for (const day of [...daily].sort((a, b) => a.date.localeCompare(b.date))) {
    const key = by === 'week' ? isoWeek(day.date) : day.date.slice(0, 7);
    groups.set(key, [...(groups.get(key) ?? []), day]);
  }
  return [...groups.entries()].map(([label, days]) => sumDays(label, days, assumptions));
}

export interface ExecutiveReport {
  generatedAt: string;
  workspace: string;
  /** Inclusive range of days covered, or undefined when there is no history. */
  range?: { from: string; to: string };
  totals: PeriodTotals;
  /** Percentage of the full-read baseline the graph context avoided, measured. */
  savingsPercent?: number;
  weekly: PeriodTotals[];
  monthly: PeriodTotals[];
  assumptions: RoiAssumptions;
  /** Lifetime totals from before daily history existed, when they differ. */
  legacy?: { analyses: number; tokensSaved: number; fileReadsAvoided: number };
}

/**
 * Everything the executive report says, computed once so the Markdown, HTML
 * and JSON forms cannot disagree.
 */
export function buildExecutiveReport(
  snapshot: TokenSavingSnapshot,
  options: {
    workspace: string;
    assumptions: RoiAssumptions;
    now: Date;
    /** Only include days on or after this `YYYY-MM-DD`. */
    since?: string;
  },
): ExecutiveReport {
  const daily = (snapshot.daily ?? [])
    .filter((day) => !options.since || day.date >= options.since)
    .sort((a, b) => a.date.localeCompare(b.date));
  const totals = sumDays('total', daily, options.assumptions);
  const percent =
    totals.baselineTokens > 0
      ? Math.round(((totals.baselineTokens - totals.contextTokens) / totals.baselineTokens) * 100)
      : undefined;
  const historyAnalyses = (snapshot.daily ?? []).reduce((sum, day) => sum + day.analyses, 0);
  const legacy =
    !options.since && snapshot.analyses > historyAnalyses
      ? {
          analyses: snapshot.analyses,
          tokensSaved: snapshot.totalTokensSaved,
          fileReadsAvoided: snapshot.totalFileReadsAvoided,
        }
      : undefined;
  return {
    generatedAt: options.now.toISOString(),
    workspace: options.workspace,
    range: daily.length ? { from: daily[0]!.date, to: daily[daily.length - 1]!.date } : undefined,
    totals,
    savingsPercent: percent === undefined ? undefined : Math.max(0, percent),
    weekly: groupDays(daily, 'week', options.assumptions),
    monthly: groupDays(daily, 'month', options.assumptions),
    assumptions: options.assumptions,
    legacy,
  };
}

function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(Math.round(value));
}

function compact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function hours(minutes: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(minutes / 60);
}

interface Labels {
  title: string;
  scope: string;
  generated: string;
  period: string;
  noData: string;
  summary: string;
  summaryText: (r: ExecutiveReport, locale: string) => string;
  pillars: string;
  cost: string;
  velocity: string;
  quality: string;
  metric: string;
  value: string;
  basis: string;
  measured: string;
  estimated: string;
  counted: string;
  tokensSaved: string;
  savingsPct: string;
  baseline: string;
  context: string;
  fileReads: string;
  analyses: string;
  chat: string;
  chatTokens: string;
  testRuns: string;
  testHours: string;
  proposals: string;
  hoursTotal: string;
  hoursByActivity: string;
  activity: string;
  count: string;
  perUnit: string;
  hoursCol: string;
  weekly: string;
  monthly: string;
  periodCol: string;
  assumptions: string;
  assumptionsNote: string;
  limits: string;
  limitsText: string[];
  legacyNote: (l: NonNullable<ExecutiveReport['legacy']>, locale: string) => string;
  activities: Record<keyof Omit<MinutesBreakdown, 'total'>, string>;
}

const EN: Labels = {
  title: 'CodeBrain executive ROI report',
  scope: 'Workspace',
  generated: 'Generated',
  period: 'Period covered',
  noData: 'No activity has been recorded yet. Use CodeBrain chat, impact analysis, or affected-test runs, then export again.',
  summary: 'Executive summary',
  summaryText: (r, locale) =>
    `Over this period CodeBrain answered **${formatNumber(r.totals.chatTotal, locale)}** chat requests and ran **${formatNumber(r.totals.analyses, locale)}** impact analyses. ` +
    `Graph context replaced **${formatNumber(r.totals.baselineTokens, locale)}** tokens of full-file reading with **${formatNumber(r.totals.contextTokens, locale)}** tokens` +
    `${r.savingsPercent !== undefined ? ` (**${r.savingsPercent}%** less, measured)` : ''}. ` +
    `At the stated assumptions this is an estimated **${hours(r.totals.minutesSaved.total, locale)} engineer-hours** saved.`,
  pillars: 'Key indicators',
  cost: 'AI cost & resources',
  velocity: 'Developer velocity',
  quality: 'Quality & risk',
  metric: 'Indicator',
  value: 'Value',
  basis: 'Basis',
  measured: 'Measured',
  estimated: 'Estimated',
  counted: 'Counted',
  tokensSaved: 'Tokens saved vs reading files in full',
  savingsPct: 'Token reduction vs full-read baseline',
  baseline: 'Full-read baseline tokens',
  context: 'Graph context tokens used',
  fileReads: 'Full-file reads avoided',
  analyses: 'Impact analyses',
  chat: 'Chat answers (explain, review, fix, implement, test, PR)',
  chatTokens: 'Model tokens used by chat (input + output)',
  testRuns: 'Affected-test runs instead of the full suite',
  testHours: 'Test waiting time saved',
  proposals: 'Code proposals applied (files changed)',
  hoursTotal: 'Engineer-hours saved',
  hoursByActivity: 'Estimated engineer-hours by activity',
  activity: 'Activity',
  count: 'Count',
  perUnit: 'Minutes saved each',
  hoursCol: 'Hours',
  weekly: 'Weekly trend',
  monthly: 'Monthly trend',
  periodCol: 'Period',
  assumptions: 'Assumptions',
  assumptionsNote: 'Hour figures are estimates: count × the minutes below. Change them in Settings → `codebrain.roi.*`. Token figures are measured from real file sizes (4 bytes ≈ 1 token on both sides) and are not billing data.',
  limits: 'Scope and limits',
  limitsText: [
    'This report covers one workspace on one developer machine. For a team total, collect each developer\'s JSON export and add them up.',
    'Test-time savings count only runs that targeted specific affected test files; full-suite runs are not counted.',
    'Activities with a 0-minute assumption contribute no hours until a team sets a figure it can defend.',
  ],
  legacyNote: (l, locale) =>
    `Before daily history was recorded, this workspace had already logged ${formatNumber(l.analyses, locale)} analyses and ${formatNumber(l.tokensSaved, locale)} tokens saved; those are not in the trend tables.`,
  activities: {
    tests: 'Affected tests instead of full suite',
    review: 'Review (/review, impact)',
    fix: 'Debug & fix (/fix)',
    explain: 'Explain & guides (/explain)',
    implement: 'Implementation plans (/implement)',
    test: 'Test generation (/test)',
    pr: 'PR descriptions (/pr)',
  },
};

const VI: Labels = {
  ...EN,
  title: 'Báo cáo hiệu quả (ROI) CodeBrain',
  scope: 'Workspace',
  generated: 'Thời điểm tạo',
  period: 'Giai đoạn',
  noData: 'Chưa có dữ liệu. Hãy dùng chat CodeBrain, phân tích ảnh hưởng hoặc chạy affected tests rồi xuất lại.',
  summary: 'Tóm tắt cho quản lý',
  summaryText: (r, locale) =>
    `Trong giai đoạn này CodeBrain đã trả lời **${formatNumber(r.totals.chatTotal, locale)}** yêu cầu chat và chạy **${formatNumber(r.totals.analyses, locale)}** lượt phân tích ảnh hưởng. ` +
    `Context đồ thị thay thế **${formatNumber(r.totals.baselineTokens, locale)}** token đọc toàn bộ file bằng **${formatNumber(r.totals.contextTokens, locale)}** token` +
    `${r.savingsPercent !== undefined ? ` (giảm **${r.savingsPercent}%**, đo thật)` : ''}. ` +
    `Theo các giả định bên dưới, ước tính tiết kiệm **${hours(r.totals.minutesSaved.total, locale)} giờ công kỹ sư**.`,
  pillars: 'Chỉ số chính',
  cost: 'Chi phí & tài nguyên AI',
  velocity: 'Tốc độ phát triển',
  quality: 'Chất lượng & rủi ro',
  metric: 'Chỉ số',
  value: 'Giá trị',
  basis: 'Cơ sở',
  measured: 'Đo thật',
  estimated: 'Ước tính',
  counted: 'Đếm',
  tokensSaved: 'Token tiết kiệm so với đọc toàn bộ file',
  savingsPct: 'Tỷ lệ giảm token so với baseline',
  baseline: 'Token baseline (đọc toàn bộ file)',
  context: 'Token context đồ thị đã dùng',
  fileReads: 'Số lượt tránh đọc toàn bộ file',
  analyses: 'Lượt phân tích ảnh hưởng',
  chat: 'Câu trả lời chat (explain, review, fix, implement, test, PR)',
  chatTokens: 'Token mô hình dùng cho chat (input + output)',
  testRuns: 'Lượt chạy affected tests thay vì full suite',
  testHours: 'Thời gian chờ test tiết kiệm',
  proposals: 'Đề xuất code đã áp dụng (số file)',
  hoursTotal: 'Giờ công kỹ sư tiết kiệm',
  hoursByActivity: 'Giờ công ước tính theo hoạt động',
  activity: 'Hoạt động',
  count: 'Số lượt',
  perUnit: 'Phút tiết kiệm mỗi lượt',
  hoursCol: 'Giờ',
  weekly: 'Xu hướng theo tuần',
  monthly: 'Xu hướng theo tháng',
  periodCol: 'Kỳ',
  assumptions: 'Giả định',
  assumptionsNote: 'Số giờ là ước tính: số lượt × số phút bên dưới. Thay đổi trong Settings → `codebrain.roi.*`. Số token được đo từ kích thước file thật (4 byte ≈ 1 token cho cả hai phía), không phải dữ liệu billing.',
  limits: 'Phạm vi và giới hạn',
  limitsText: [
    'Báo cáo này chỉ gồm một workspace trên máy của một lập trình viên. Để có tổng cho cả nhóm, gom file JSON xuất từ từng người và cộng lại.',
    'Thời gian test tiết kiệm chỉ tính các lượt chạy nhắm vào đúng file test bị ảnh hưởng; lượt chạy full suite không được tính.',
    'Hoạt động có giả định 0 phút không đóng góp giờ nào cho đến khi nhóm đặt một con số có cơ sở.',
  ],
  legacyNote: (l, locale) =>
    `Trước khi có lịch sử theo ngày, workspace này đã ghi ${formatNumber(l.analyses, locale)} lượt phân tích và ${formatNumber(l.tokensSaved, locale)} token tiết kiệm; các số đó không nằm trong bảng xu hướng.`,
  activities: {
    tests: 'Affected tests thay vì full suite',
    review: 'Review (/review, impact)',
    fix: 'Debug & sửa lỗi (/fix)',
    explain: 'Giải thích & hướng dẫn (/explain)',
    implement: 'Kế hoạch triển khai (/implement)',
    test: 'Sinh test (/test)',
    pr: 'Mô tả PR (/pr)',
  },
};

function labelsFor(language: string): { labels: Labels; locale: string } {
  return language === 'vi' ? { labels: VI, locale: 'vi-VN' } : { labels: EN, locale: 'en-US' };
}

interface ActivityRow {
  key: keyof Omit<MinutesBreakdown, 'total'>;
  count: number;
  perUnit: number;
  minutes: number;
}

function activityRows(report: ExecutiveReport): ActivityRow[] {
  const a = report.assumptions;
  const t = report.totals;
  const c = t.chatRequests;
  return [
    { key: 'tests' as const, count: t.affectedTestRuns, perUnit: Math.max(0, a.fullSuiteMinutes - a.affectedTestMinutes), minutes: t.minutesSaved.tests },
    { key: 'review' as const, count: chatCount(c, 'review', 'impact'), perUnit: a.minutesSavedPerReview, minutes: t.minutesSaved.review },
    { key: 'fix' as const, count: chatCount(c, 'fix'), perUnit: a.minutesSavedPerFix, minutes: t.minutesSaved.fix },
    { key: 'explain' as const, count: chatCount(c, 'explain', 'guide'), perUnit: a.minutesSavedPerExplain, minutes: t.minutesSaved.explain },
    { key: 'implement' as const, count: chatCount(c, 'implement'), perUnit: a.minutesSavedPerImplement, minutes: t.minutesSaved.implement },
    { key: 'test' as const, count: chatCount(c, 'test'), perUnit: a.minutesSavedPerTest, minutes: t.minutesSaved.test },
    { key: 'pr' as const, count: chatCount(c, 'pr'), perUnit: a.minutesSavedPerPr, minutes: t.minutesSaved.pr },
  ];
}

function indicatorRows(report: ExecutiveReport, labels: Labels, locale: string): Array<[string, string, string, string]> {
  const t = report.totals;
  return [
    [labels.cost, labels.tokensSaved, formatNumber(t.tokensSaved, locale), labels.measured],
    [labels.cost, labels.savingsPct, report.savingsPercent !== undefined ? `${report.savingsPercent}%` : '—', labels.measured],
    [labels.cost, labels.baseline, formatNumber(t.baselineTokens, locale), labels.measured],
    [labels.cost, labels.context, formatNumber(t.contextTokens, locale), labels.measured],
    [labels.cost, labels.chatTokens, formatNumber(t.chatInputTokens + t.chatOutputTokens, locale), labels.measured],
    [labels.velocity, labels.fileReads, formatNumber(t.fileReadsAvoided, locale), labels.counted],
    [labels.velocity, labels.testRuns, formatNumber(t.affectedTestRuns, locale), labels.counted],
    [labels.velocity, labels.testHours, `${hours(t.minutesSaved.tests, locale)} h`, labels.estimated],
    [labels.velocity, labels.hoursTotal, `${hours(t.minutesSaved.total, locale)} h`, labels.estimated],
    [labels.quality, labels.analyses, formatNumber(t.analyses, locale), labels.counted],
    [labels.quality, labels.chat, formatNumber(t.chatTotal, locale), labels.counted],
    [labels.quality, labels.proposals, `${formatNumber(t.proposalsApplied, locale)} (${formatNumber(t.proposalFiles, locale)})`, labels.counted],
  ];
}

function trendTableMarkdown(periods: readonly PeriodTotals[], labels: Labels, locale: string): string {
  const header = `| ${labels.periodCol} | ${labels.chat} | ${labels.analyses} | ${labels.tokensSaved} | ${labels.testRuns} | ${labels.hoursTotal} |`;
  const rows = periods.map(
    (p) =>
      `| ${p.label} | ${formatNumber(p.chatTotal, locale)} | ${formatNumber(p.analyses, locale)} | ${formatNumber(p.tokensSaved, locale)} | ${formatNumber(p.affectedTestRuns, locale)} | ${hours(p.minutesSaved.total, locale)} |`,
  );
  return [header, '| :--- | ---: | ---: | ---: | ---: | ---: |', ...rows].join('\n');
}

function assumptionRows(a: RoiAssumptions): Array<[string, number]> {
  return [
    ['codebrain.roi.fullSuiteMinutes', a.fullSuiteMinutes],
    ['codebrain.roi.affectedTestMinutes', a.affectedTestMinutes],
    ['codebrain.roi.minutesSavedPerReview', a.minutesSavedPerReview],
    ['codebrain.roi.minutesSavedPerFix', a.minutesSavedPerFix],
    ['codebrain.roi.minutesSavedPerExplain', a.minutesSavedPerExplain],
    ['codebrain.roi.minutesSavedPerImplement', a.minutesSavedPerImplement],
    ['codebrain.roi.minutesSavedPerTest', a.minutesSavedPerTest],
    ['codebrain.roi.minutesSavedPerPr', a.minutesSavedPerPr],
  ];
}

export function renderExecutiveMarkdown(report: ExecutiveReport, language: string): string {
  const { labels, locale } = labelsFor(language);
  const lines: string[] = [`# ${labels.title}`, ''];
  lines.push(`- **${labels.scope}:** ${report.workspace}`);
  lines.push(`- **${labels.generated}:** ${report.generatedAt.slice(0, 16).replace('T', ' ')}`);
  lines.push(`- **${labels.period}:** ${report.range ? `${report.range.from} → ${report.range.to}` : '—'}`);
  lines.push('');
  lines.push(`## ${labels.summary}`, '');
  if (!report.range) {
    lines.push(labels.noData, '');
  } else {
    lines.push(labels.summaryText(report, locale), '');
  }
  if (report.legacy) lines.push(`> ${labels.legacyNote(report.legacy, locale)}`, '');

  lines.push(`## ${labels.pillars}`, '');
  lines.push(`| | ${labels.metric} | ${labels.value} | ${labels.basis} |`, '| :--- | :--- | ---: | :--- |');
  for (const [pillar, metric, value, basis] of indicatorRows(report, labels, locale)) {
    lines.push(`| ${pillar} | ${metric} | ${value} | ${basis} |`);
  }
  lines.push('');

  lines.push(`## ${labels.hoursByActivity}`, '');
  lines.push(`| ${labels.activity} | ${labels.count} | ${labels.perUnit} | ${labels.hoursCol} |`, '| :--- | ---: | ---: | ---: |');
  for (const row of activityRows(report)) {
    lines.push(`| ${labels.activities[row.key]} | ${formatNumber(row.count, locale)} | ${row.perUnit} | ${hours(row.minutes, locale)} |`);
  }
  lines.push(`| **${labels.hoursTotal}** | | | **${hours(report.totals.minutesSaved.total, locale)}** |`, '');

  if (report.weekly.length > 0) {
    const recent = report.weekly.slice(-12);
    lines.push(`## ${labels.weekly}`, '');
    lines.push(
      '```mermaid',
      'xychart-beta',
      `  title "${labels.tokensSaved}"`,
      `  x-axis [${recent.map((p) => `"${p.label.slice(5)}"`).join(', ')}]`,
      `  bar [${recent.map((p) => Math.round(p.tokensSaved)).join(', ')}]`,
      '```',
      '',
    );
    lines.push(trendTableMarkdown(recent, labels, locale), '');
  }
  if (report.monthly.length > 0) {
    lines.push(`## ${labels.monthly}`, '');
    lines.push(trendTableMarkdown(report.monthly.slice(-12), labels, locale), '');
  }

  lines.push(`## ${labels.assumptions}`, '', labels.assumptionsNote, '');
  lines.push(`| Setting | Minutes |`, '| :--- | ---: |');
  for (const [key, value] of assumptionRows(report.assumptions)) lines.push(`| \`${key}\` | ${value} |`);
  lines.push('');
  lines.push(`## ${labels.limits}`, '', ...labels.limitsText.map((text) => `- ${text}`), '');
  return lines.join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** `**bold**` and `` `code` `` only — all the summary sentences use. */
function inlineHtml(markdown: string): string {
  return escapeHtml(markdown)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * One single-series bar chart as inline SVG: bars with a hover title per mark
 * (the native tooltip, so the file stays self-contained and script-free), a
 * recessive baseline, and selective direct labels on the latest and the
 * largest bar only.
 */
function barChartSvg(
  periods: readonly PeriodTotals[],
  value: (period: PeriodTotals) => number,
  format: (value: number) => string,
  ariaLabel: string,
): string {
  if (periods.length === 0) return '';
  const width = 640;
  const height = 200;
  const top = 24;
  const bottom = 28;
  const left = 8;
  const plotHeight = height - top - bottom;
  const max = Math.max(1, ...periods.map(value));
  const slot = (width - left * 2) / periods.length;
  const barWidth = Math.max(4, Math.min(36, slot - 6));
  const peakIndex = periods.reduce((best, p, i) => (value(p) > value(periods[best]!) ? i : best), 0);
  const bars = periods
    .map((period, index) => {
      const v = value(period);
      const h = v <= 0 ? 0 : Math.max(2, (v / max) * plotHeight);
      const x = left + index * slot + (slot - barWidth) / 2;
      const y = top + plotHeight - h;
      const r = Math.min(4, barWidth / 2, h);
      // Rounded data end, square at the baseline.
      const path =
        h <= 0
          ? ''
          : `<path class="bar" d="M${x},${top + plotHeight} V${y + r} Q${x},${y} ${x + r},${y} H${x + barWidth - r} Q${x + barWidth},${y} ${x + barWidth},${y + r} V${top + plotHeight} Z"><title>${escapeHtml(period.label)}: ${escapeHtml(format(v))}</title></path>`;
      const hit = `<rect class="hit" x="${left + index * slot}" y="${top}" width="${slot}" height="${plotHeight}"><title>${escapeHtml(period.label)}: ${escapeHtml(format(v))}</title></rect>`;
      const showLabel = v > 0 && (index === periods.length - 1 || index === peakIndex);
      const label = showLabel
        ? `<text class="value" x="${x + barWidth / 2}" y="${y - 6}" text-anchor="middle">${escapeHtml(format(v))}</text>`
        : '';
      const tick =
        periods.length <= 12 || index % Math.ceil(periods.length / 12) === 0
          ? `<text class="tick" x="${x + barWidth / 2}" y="${height - 8}" text-anchor="middle">${escapeHtml(period.label.slice(5) || period.label)}</text>`
          : '';
      return `${hit}${path}${label}${tick}`;
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(ariaLabel)}" preserveAspectRatio="xMidYMid meet"><line class="axis" x1="${left}" x2="${width - left}" y1="${top + plotHeight}" y2="${top + plotHeight}"/>${bars}</svg>`;
}

export function renderExecutiveHtml(report: ExecutiveReport, language: string): string {
  const { labels, locale } = labelsFor(language);
  const recent = report.weekly.slice(-12);
  const tiles: Array<[string, string, string]> = [
    [labels.tokensSaved, compact(report.totals.tokensSaved, locale), labels.measured],
    [labels.savingsPct, report.savingsPercent !== undefined ? `${report.savingsPercent}%` : '—', labels.measured],
    [labels.fileReads, compact(report.totals.fileReadsAvoided, locale), labels.counted],
    [labels.testRuns, compact(report.totals.affectedTestRuns, locale), labels.counted],
  ];
  const table = (head: string[], rows: string[][], numeric: boolean[]): string =>
    `<div class="table-wrap"><table><thead><tr>${head.map((h, i) => `<th class="${numeric[i] ? 'num' : ''}">${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows
      .map((row) => `<tr>${row.map((cell, i) => `<td class="${numeric[i] ? 'num' : ''}">${inlineHtml(cell)}</td>`).join('')}</tr>`)
      .join('')}</tbody></table></div>`;
  const trendTable = (periods: readonly PeriodTotals[]) =>
    table(
      [labels.periodCol, labels.chat, labels.analyses, labels.tokensSaved, labels.testRuns, labels.hoursTotal],
      periods.map((p) => [
        p.label,
        formatNumber(p.chatTotal, locale),
        formatNumber(p.analyses, locale),
        formatNumber(p.tokensSaved, locale),
        formatNumber(p.affectedTestRuns, locale),
        hours(p.minutesSaved.total, locale),
      ]),
      [false, true, true, true, true, true],
    );

  const body = !report.range
    ? `<p>${escapeHtml(labels.noData)}</p>`
    : `
<section class="hero">
  <div class="hero-value">${escapeHtml(hours(report.totals.minutesSaved.total, locale))} h</div>
  <div class="hero-label">${escapeHtml(labels.hoursTotal)} · ${escapeHtml(labels.estimated)}</div>
</section>
<p class="summary">${inlineHtml(labels.summaryText(report, locale))}</p>
${report.legacy ? `<p class="note">${inlineHtml(labels.legacyNote(report.legacy, locale))}</p>` : ''}
<section class="tiles">${tiles
        .map(([label, value, basis]) => `<div class="tile"><div class="tile-label">${escapeHtml(label)}</div><div class="tile-value">${escapeHtml(value)}</div><div class="tile-basis">${escapeHtml(basis)}</div></div>`)
        .join('')}</section>
<h2>${escapeHtml(labels.pillars)}</h2>
${table(
  ['', labels.metric, labels.value, labels.basis],
  indicatorRows(report, labels, locale).map((row) => [...row]),
  [false, false, true, false],
)}
<h2>${escapeHtml(labels.hoursByActivity)}</h2>
${table(
  [labels.activity, labels.count, labels.perUnit, labels.hoursCol],
  [
    ...activityRows(report).map((row) => [labels.activities[row.key], formatNumber(row.count, locale), String(row.perUnit), hours(row.minutes, locale)]),
    [`**${labels.hoursTotal}**`, '', '', `**${hours(report.totals.minutesSaved.total, locale)}**`],
  ],
  [false, true, true, true],
)}
${recent.length ? `<h2>${escapeHtml(labels.weekly)}</h2>
<figure><figcaption>${escapeHtml(labels.tokensSaved)}</figcaption>${barChartSvg(recent, (p) => p.tokensSaved, (v) => compact(v, locale), labels.tokensSaved)}</figure>
<figure><figcaption>${escapeHtml(labels.hoursTotal)} (${escapeHtml(labels.estimated)})</figcaption>${barChartSvg(recent, (p) => p.minutesSaved.total / 60, (v) => `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(v)} h`, labels.hoursTotal)}</figure>
${trendTable(recent)}` : ''}
${report.monthly.length ? `<h2>${escapeHtml(labels.monthly)}</h2>${trendTable(report.monthly.slice(-12))}` : ''}`;

  return `<!doctype html>
<html lang="${language === 'vi' ? 'vi' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(labels.title)} — ${escapeHtml(report.workspace)}</title>
<style>
:root {
  color-scheme: light;
  --surface: #fcfcfb;
  --surface-2: #f2f1ee;
  --border: #dedcd6;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #77756f;
  --series-1: #2a78d6;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --surface: #1a1a19;
    --surface-2: #242423;
    --border: #3a3a38;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #9a998f;
    --series-1: #3987e5;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--text-primary); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 36px 0 12px; }
.meta { color: var(--text-secondary); margin: 0 0 24px; }
.hero { margin: 24px 0 8px; }
.hero-value { font-size: 56px; font-weight: 600; line-height: 1.1; }
.hero-label { color: var(--text-secondary); }
.summary { max-width: 72ch; }
.note { color: var(--text-secondary); font-size: 13px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 20px 0; }
.tile { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
.tile-label { color: var(--text-secondary); font-size: 13px; }
.tile-value { font-size: 26px; font-weight: 600; }
.tile-basis { color: var(--text-muted); font-size: 12px; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--text-secondary); font-weight: 600; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td:first-child { white-space: nowrap; }
figure { margin: 12px 0 20px; }
figcaption { color: var(--text-secondary); font-size: 13px; margin-bottom: 4px; }
svg { width: 100%; height: auto; display: block; }
svg .bar { fill: var(--series-1); }
svg .hit { fill: transparent; }
svg .hit:hover + .bar, svg .bar:hover { opacity: .8; }
svg .axis { stroke: var(--border); stroke-width: 1; }
svg .tick { fill: var(--text-muted); font-size: 11px; }
svg .value { fill: var(--text-primary); font-size: 11px; font-weight: 600; }
code { font-size: 13px; }
ul { padding-left: 20px; }
@media print { body { background: #fff; } .tile { break-inside: avoid; } }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(labels.title)}</h1>
<p class="meta">${escapeHtml(labels.scope)}: ${escapeHtml(report.workspace)} · ${escapeHtml(labels.period)}: ${escapeHtml(report.range ? `${report.range.from} → ${report.range.to}` : '—')} · ${escapeHtml(labels.generated)}: ${escapeHtml(report.generatedAt.slice(0, 16).replace('T', ' '))}</p>
${body}
<h2>${escapeHtml(labels.assumptions)}</h2>
<p class="note">${inlineHtml(labels.assumptionsNote)}</p>
${table(['Setting', 'Minutes'], assumptionRows(report.assumptions).map(([key, value]) => [`\`${key}\``, String(value)]), [false, true])}
<h2>${escapeHtml(labels.limits)}</h2>
<ul>${labels.limitsText.map((text) => `<li>${inlineHtml(text)}</li>`).join('')}</ul>
</main>
</body>
</html>
`;
}
