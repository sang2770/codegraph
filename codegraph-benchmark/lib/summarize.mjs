#!/usr/bin/env node
// Aggregate results.jsonl → report.md + runs.csv + scenarios.csv (one section per agent).
// Usage: node lib/summarize.mjs <results-dir>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir || !existsSync(join(dir, 'results.jsonl'))) {
  console.error('usage: summarize.mjs <results-dir containing results.jsonl>');
  process.exit(2);
}
const meta = existsSync(join(dir, 'meta.json')) ? JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) : {};
const runs = readFileSync(join(dir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).map((r) => ({ agent: 'copilot', ...r }));

const AGENT_NAME = { copilot: 'GitHub Copilot CLI', claude: 'Claude Code' };
const agents = [...new Set(runs.map((r) => r.agent))];

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const mean = (xs) => { const v = xs.filter((x) => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

const METRICS = {
  wallS: { label: 'Thời gian (s)', get: (r) => r.wallMs / 1000 },
  turns: { label: 'Số lượt model', get: (r) => r.turns },
  tools: { label: 'Tổng tool calls', get: (r) => r.tools.total },
  reads: { label: 'Đọc file (Read/view + cat/head…)', get: (r) => r.tools.read + r.tools.bashRead },
  searches: { label: 'Tìm kiếm (Grep/Glob/rg + grep/find)', get: (r) => r.tools.search + r.tools.bashSearch },
  codegraph: { label: 'CodeGraph calls', get: (r) => r.tools.codegraph },
  inTok: { label: 'Input tokens (gồm cache)', get: (r) => r.tokens.input },
  outTok: { label: 'Output tokens', get: (r) => r.tokens.output },
  costUsd: { label: 'Chi phí (USD)', get: (r) => r.costUsd ?? null },
  credits: { label: 'AI credits', get: (r) => (r.nanoAiu == null ? null : r.nanoAiu / 1e9) },
  premium: { label: 'Premium requests', get: (r) => r.premiumRequests },
};
const DELTA_KEYS = ['wallS', 'turns', 'tools', 'reads', 'searches', 'inTok', 'outTok', 'costUsd', 'credits'];

const pct = (d) => (d == null ? '–' : `${d.med > 0 ? '+' : ''}${d.med.toFixed(0)}%`);
const range = (d) => (d == null ? '' : ` <sub>(${d.min.toFixed(0)}…${d.max > 0 ? '+' : ''}${d.max.toFixed(0)})</sub>`);
const num = (x, dp = 0) => (x == null ? '–' : Number(x).toFixed(dp));
const pctOf = (x) => (x == null ? '–' : `${(x * 100).toFixed(0)}%`);
const tag = (r) => `${r.id}·${r.arm}#${r.run}`;

function analyse(agentRuns) {
  const valid = agentRuns.filter((r) => r.completed && !r.tampered);
  const invalid = agentRuns.filter((r) => !r.completed || r.tampered);
  const withRuns = valid.filter((r) => r.arm === 'with');
  const notAttached = withRuns.filter((r) => r.mcpAttached === false);
  const unused = withRuns.filter((r) => r.mcpAttached !== false && r.tools.codegraph === 0);
  // A codegraph call the permission system refused never reached the server.
  const cgDenied = withRuns.filter((r) => Object.keys(r.denied ?? {}).some((n) => /codegraph/i.test(n)));

  const ids = [...new Set(agentRuns.map((r) => r.id))];
  const perScenario = ids.map((id) => {
    const row = { id, repo: null, type: null, kind: null, arms: {} };
    for (const arm of ['without', 'with']) {
      const rs = valid.filter((r) => r.id === id && r.arm === arm);
      if (!rs.length) continue;
      Object.assign(row, { repo: rs[0].repo, type: rs[0].type, kind: rs[0].kind });
      const m = { n: rs.length };
      for (const [k, def] of Object.entries(METRICS)) m[k] = median(rs.map(def.get));
      m.score = mean(rs.map((r) => r.score.expect));
      const det = rs.filter((r) => r.score.detected !== null);
      m.detectRate = det.length ? det.filter((r) => r.score.detected).length / det.length : null;
      row.arms[arm] = m;
    }
    return row;
  });

  // Median over scenarios of the with/without ratio, so each scenario weighs equally.
  const aggregate = (filter) => {
    const sc = perScenario.filter((s) => s.arms.with && s.arms.without && filter(s));
    const out = { scenarios: sc.length };
    for (const k of DELTA_KEYS) {
      const ratios = sc.map((s) => (s.arms.without[k] > 0 && s.arms.with[k] != null ? s.arms.with[k] / s.arms.without[k] : null)).filter((x) => x != null);
      out[k] = ratios.length ? { med: (median(ratios) - 1) * 100, min: (Math.min(...ratios) - 1) * 100, max: (Math.max(...ratios) - 1) * 100 } : null;
    }
    for (const arm of ['without', 'with']) {
      out[`score_${arm}`] = mean(sc.map((s) => s.arms[arm].score));
      const d = sc.map((s) => s.arms[arm].detectRate).filter((x) => x != null);
      out[`detect_${arm}`] = d.length ? mean(d) : null;
      out[`cg_${arm}`] = median(sc.map((s) => s.arms[arm].codegraph));
    }
    return out;
  };
  const groups = [
    ['Phân tích code', (s) => s.type === 'analysis'],
    ['Review code', (s) => s.type === 'review'],
    ['Tổng', () => true],
  ].map(([name, f]) => [name, aggregate(f)]);

  return { valid, invalid, notAttached, unused, cgDenied, perScenario, groups };
}

const results = Object.fromEntries(agents.map((a) => [a, analyse(runs.filter((r) => r.agent === a))]));
const ids = [...new Set(runs.map((r) => r.id))];

let md = `# Báo cáo benchmark CodeGraph × ${agents.map((a) => AGENT_NAME[a] ?? a).join(' / ')}\n\n`;
md += `- Thời điểm: ${meta.started ?? runs[0]?.at ?? '?'}\n`;
md += `- Model: \`${meta.model ?? runs[0]?.model}\` · effort \`${meta.effort ?? runs[0]?.effort}\` · CodeGraph ${meta.codegraph ?? runs[0]?.codegraphVersion ?? '?'}\n`;
for (const a of agents) {
  const v = runs.find((r) => r.agent === a && r.agentVersion)?.agentVersion ?? meta.versions?.[a] ?? '';
  md += `- ${AGENT_NAME[a] ?? a}: ${v} — ${runs.filter((r) => r.agent === a).length} run (hợp lệ: ${results[a].valid.length})\n`;
}
md += `- ${ids.length} kịch bản × 2 arm × ${meta.runs ?? '?'} lần mỗi agent\n\n`;

if (agents.length > 1) {
  md += `## So sánh nhanh giữa các agent (Tổng, with so với without)\n\n`;
  md += `| Chỉ số | ${agents.map((a) => AGENT_NAME[a] ?? a).join(' | ')} |\n|---|${agents.map(() => '---').join('|')}|\n`;
  for (const k of ['wallS', 'tools', 'reads', 'searches', 'inTok', 'costUsd', 'credits']) {
    if (agents.every((a) => results[a].groups[2][1][k] == null)) continue;
    md += `| ${METRICS[k].label} | ${agents.map((a) => pct(results[a].groups[2][1][k])).join(' | ')} |\n`;
  }
  md += `| Điểm chất lượng without → with | ${agents.map((a) => { const g = results[a].groups[2][1]; return `${pctOf(g.score_without)} → ${pctOf(g.score_with)}`; }).join(' | ')} |\n`;
  md += `| Bắt bug cài sẵn without → with | ${agents.map((a) => { const g = results[a].groups[2][1]; return g.detect_without == null ? '–' : `${pctOf(g.detect_without)} → ${pctOf(g.detect_with)}`; }).join(' | ')} |\n\n`;
  md += `Chi phí tuyệt đối không so sánh trực tiếp được giữa hai agent (Claude Code tính USD, Copilot tính AI credits / premium requests); hãy so sánh **mức thay đổi %** mà CodeGraph tạo ra trong từng agent.\n\n`;
}

for (const a of agents) {
  const R = results[a];
  md += `## ${AGENT_NAME[a] ?? a}\n\n`;
  if (R.invalid.length || R.notAttached.length || R.unused.length || R.cgDenied.length) {
    md += `> **Cảnh báo độ tin cậy**\n`;
    if (R.cgDenied.length) md += `> - ${R.cgDenied.length} run arm "with" có lệnh gọi CodeGraph **bị từ chối quyền** (tool không chạy — thường do managed settings tắt \`bypassPermissions\`; xem \`permissionMode\` trong results.jsonl): ${R.cgDenied.map(tag).join(', ')}\n`;
    if (R.invalid.length) md += `> - ${R.invalid.length} run bị loại (không hoàn thành / timeout / agent sửa file): ${R.invalid.map(tag).join(', ')}\n`;
    if (R.notAttached.length) md += `> - ${R.notAttached.length} run arm "with" mà MCP CodeGraph **không kết nối được**: ${R.notAttached.map(tag).join(', ')}\n`;
    if (R.unused.length) md += `> - ${R.unused.length} run arm "with" có CodeGraph nhưng agent **không gọi lần nào**: ${R.unused.map(tag).join(', ')}\n`;
    md += `\n`;
  }

  md += `### Kết quả chính (with so với without)\n\n`;
  md += `Giá trị = trung vị trên các kịch bản của tỉ lệ with/without; số nhỏ là khoảng min…max giữa các kịch bản. **Âm = CodeGraph giảm.**\n\n`;
  md += `| Chỉ số | ${R.groups.map(([n, g]) => `${n} (${g.scenarios})`).join(' | ')} |\n|---|${R.groups.map(() => '---').join('|')}|\n`;
  for (const k of DELTA_KEYS) {
    if (R.groups.every(([, g]) => g[k] == null)) continue;
    md += `| ${METRICS[k].label} | ${R.groups.map(([, g]) => pct(g[k]) + range(g[k])).join(' | ')} |\n`;
  }
  md += `| Điểm chất lượng without → with | ${R.groups.map(([, g]) => `${pctOf(g.score_without)} → ${pctOf(g.score_with)}`).join(' | ')} |\n`;
  md += `| Tỉ lệ bắt được bug cài sẵn without → with | ${R.groups.map(([, g]) => (g.detect_without == null ? '–' : `${pctOf(g.detect_without)} → ${pctOf(g.detect_with)}`)).join(' | ')} |\n`;
  md += `| CodeGraph calls / run (trung vị, arm with) | ${R.groups.map(([, g]) => num(g.cg_with)).join(' | ')} |\n\n`;

  const costKey = a === 'claude' ? 'costUsd' : 'credits';
  md += `### Chi tiết từng kịch bản (trung vị mỗi arm: without / with)\n\n`;
  md += `| Kịch bản | Loại | Thời gian s | Tools | Đọc | Tìm | CG | Input tok (k) | ${a === 'claude' ? 'USD' : 'Credits'} | Điểm | Bắt bug |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const s of R.perScenario) {
    const x = s.arms.without ?? {}, y = s.arms.with ?? {};
    const pair = (k, dp = 0, f = (v) => v) => `${num(f(x[k]), dp)} / ${num(f(y[k]), dp)}`;
    md += `| \`${s.id}\` | ${s.type}/${s.kind} | ${pair('wallS')} | ${pair('tools')} | ${pair('reads')} | ${pair('searches')} | ${pair('codegraph')} | ${pair('inTok', 0, (v) => (v == null ? null : v / 1000))} | ${pair(costKey, costKey === 'costUsd' ? 3 : 2)} | ${pctOf(x.score)} / ${pctOf(y.score)} | ${x.detectRate == null ? '–' : `${pctOf(x.detectRate)} / ${pctOf(y.detectRate)}`} |\n`;
  }
  md += `\n`;
}

md += `## Phương pháp\n\n`;
md += `- Hai arm chỉ khác nhau ở việc có gắn MCP server CodeGraph hay không. Cả hai: cùng model/effort/prompt, tắt mọi MCP server khác, tắt instructions/hook/plugin toàn cục của người dùng, cấm ghi file và truy cập mạng. Arm without còn bị cấm gọi lệnh \`codegraph\` qua shell.\n`;
md += `  - Copilot CLI: \`--disable-builtin-mcps --no-custom-instructions --deny-tool=write\`, CodeGraph qua \`--additional-mcp-config\`.\n`;
md += `  - Claude Code: \`--strict-mcp-config --setting-sources project,local --disallowedTools Edit Write NotebookEdit\`, CodeGraph qua \`--mcp-config\`.\n`;
md += `- **Phân tích**: câu hỏi flow / impact / kiến trúc trên code thật. **Review**: agent review \`git diff\` chưa commit — gồm bug được cài sẵn (có đáp án) và một commit thật của upstream.\n`;
md += `- **Điểm chất lượng** = tỉ lệ nhóm từ khoá kỳ vọng xuất hiện trong câu trả lời cuối (heuristic, nên đọc kiểm tra \`*.answer.md\`). **Bắt bug** = câu trả lời nêu đúng vị trí và bản chất bug cài sẵn.\n`;
md += `- Input tokens đã bao gồm token đọc/ghi cache ở cả hai agent. Chi phí: Claude Code = \`total_cost_usd\`; Copilot = \`totalNanoAiu / 1e9\` AI credits và premium requests.\n`;
md += `- Biến động giữa các lần chạy lớn: đừng kết luận từ 1 run; xem khoảng min…max.\n`;
writeFileSync(join(dir, 'report.md'), md);

const csvEsc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const runCols = ['agent', 'id', 'repo', 'type', 'kind', 'arm', 'run', 'completed', 'tampered', 'mcpAttached', 'wallS', 'turns', 'tools', 'reads', 'searches', 'codegraph', 'inTok', 'cachedTok', 'outTok', 'costUsd', 'credits', 'premium', 'score', 'detected'];
const runCsv = [runCols.join(',')].concat(runs.map((r) => [
  r.agent, r.id, r.repo, r.type, r.kind, r.arm, r.run, r.completed, r.tampered, r.mcpAttached, (r.wallMs / 1000).toFixed(1), r.turns, r.tools.total,
  r.tools.read + r.tools.bashRead, r.tools.search + r.tools.bashSearch, r.tools.codegraph, r.tokens.input, r.tokens.cacheRead,
  r.tokens.output, r.costUsd, r.nanoAiu == null ? '' : (r.nanoAiu / 1e9).toFixed(3), r.premiumRequests, r.score.expect, r.score.detected,
].map(csvEsc).join(',')));
writeFileSync(join(dir, 'runs.csv'), runCsv.join('\n') + '\n');

const scCols = ['agent', 'id', 'type', 'kind', 'arm', 'n', ...Object.keys(METRICS), 'score', 'detectRate'];
const scCsv = [scCols.join(',')];
for (const a of agents) for (const s of results[a].perScenario) for (const arm of ['without', 'with']) {
  const m = s.arms[arm]; if (!m) continue;
  scCsv.push([a, s.id, s.type, s.kind, arm, m.n, ...Object.keys(METRICS).map((k) => m[k]), m.score, m.detectRate].map(csvEsc).join(','));
}
writeFileSync(join(dir, 'scenarios.csv'), scCsv.join('\n') + '\n');

console.log(md);
console.log(`\nwrote ${join(dir, 'report.md')}, runs.csv, scenarios.csv`);
