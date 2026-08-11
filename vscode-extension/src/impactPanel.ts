import { resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  IMPACT_RISK_THRESHOLDS,
  ImpactAnalysis,
  ImpactNode,
} from './impact';
import { TokenSavingSnapshot } from './metrics';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function nonce(): string {
  return randomBytes(16).toString('hex');
}

function metric(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function riskScore(analysis?: ImpactAnalysis): string {
  return analysis?.assessment
    ? `${analysis.assessment.score}/${analysis.assessment.maxScore}`
    : '—';
}

function coverageLabel(analysis?: ImpactAnalysis): string {
  if (!analysis?.assessment) return 'Not analyzed';
  return {
    covered: 'Covered',
    partial: 'Partial',
    gap: 'Gap',
    none: 'No dependents',
  }[analysis.assessment.coverage];
}

function confidenceLabel(analysis?: ImpactAnalysis): string {
  if (!analysis?.assessment) return '—';
  return {
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  }[analysis.assessment.confidence];
}

function evidenceBanner(analysis?: ImpactAnalysis): string {
  if (!analysis) return '';
  if (analysis.dependencyEdges !== undefined) {
    const dependentCount = analysis.dependentFiles?.length ?? 0;
    const edgeCount = analysis.dependencyEdges.length;
    if (dependentCount === 0 && analysis.affectedTests.length === 0) {
      return `<div class="evidence-banner quiet"><strong>No indexed dependent workflow found.</strong><span>This is evidence from the current graph, not a guarantee that dynamic runtime usage is absent.</span></div>`;
    }
    return `<div class="evidence-banner good"><strong>Indexed evidence</strong><span>${metric(edgeCount)} dependency edges traced. ${metric(dependentCount)} dependent workflow${dependentCount === 1 ? '' : 's'} and ${metric(analysis.affectedTests.length)} affected test${analysis.affectedTests.length === 1 ? '' : 's'} surfaced.</span></div>`;
  }
  return `<div class="evidence-banner warn"><strong>Partial evidence</strong><span>This runtime returned paths but not dependency edges. Refresh the bundled runtime before relying on graph relationships.</span></div>`;
}

function truncationBanner(analysis?: ImpactAnalysis): string {
  if (analysis?.depthTruncated !== true) return '';
  return `<div class="evidence-banner warn"><strong>Counts are a lower bound</strong><span>The dependency traversal stopped at its depth limit of ${analysis.depthLimit} while more of the graph was still reachable. Raise <code>codebrain.impact.maxDepth</code> to see the full blast radius.</span></div>`;
}

function impactDescription(analysis?: ImpactAnalysis): string {
  if (!analysis?.assessment) return 'Run an analysis to calculate the impact level.';
  const blast = analysis.assessment.signals.find((signal) => signal.key === 'blastRadius');
  const sensitive = analysis.assessment.signals.find((signal) => signal.key === 'sensitivity');
  const test = analysis.assessment.signals.find((signal) => signal.key === 'testCoverage');
  const dependentCount = analysis.dependentFiles?.length ?? analysis.totalDependentsTraversed;
  const lead =
    (blast?.score ?? 0) >= 3
      ? `driven by a large blast radius across ${metric(dependentCount)} dependent workflows`
      : (blast?.score ?? 0) > 0
        ? `driven by ${metric(dependentCount)} dependent workflows`
        : 'driven by a narrow indexed blast radius';
  const qualifiers = [
    (sensitive?.score ?? 0) === 0 ? 'No sensitive contract surface' : 'Sensitive contract surface detected',
    (test?.score ?? 0) === 0 ? 'no test-evidence penalty detected' : 'missing test evidence increases risk',
  ];
  return `${analysis.risk.toUpperCase()} ${riskScore(analysis)} — ${lead}. ${qualifiers.join(' and ')}.`;
}

function blastRadiusDetails(analysis: ImpactAnalysis): string {
  const total = analysis.dependentFiles?.length ?? analysis.totalDependentsTraversed;
  const direct = analysis.directDependents ?? analysis.nodes.filter((node) => node.kind === 'dependent').length;
  const transitive = analysis.transitiveDependents ?? Math.max(0, total - direct);
  const workflows = analysis.topWorkflows?.length
    ? analysis.topWorkflows
    : analysis.nodes
        .filter((node) => node.kind === 'dependent')
        .slice(0, 5)
        .map((node) => ({ path: node.path, fanOut: 1 }));
  return `<details class="blast-details">
    <summary>Show direct, transitive, and highest-fan-out workflows</summary>
    <div class="breakdown"><span><strong>${metric(direct)}</strong> direct dependents</span><span><strong>${metric(transitive)}</strong> transitive dependents</span><span><strong>${metric(total)}</strong> total indexed dependents</span></div>
    <h3>Top workflows by fan-out</h3>
    ${workflows.length > 0 ? `<ul>${workflows.slice(0, 5).map((workflow) => `<li><code>${escapeHtml(workflow.path)}</code><span class="fanout">${metric(workflow.fanOut)} dependents</span></li>`).join('')}</ul>` : '<div class="muted">No workflow fan-out evidence was returned by the current index.</div>'}
  </details>`;
}

function assessmentSection(analysis?: ImpactAnalysis): string {
  if (!analysis?.assessment) return '';
  const assessment = analysis.assessment;
  const signals = assessment.signals
    .map((signal) => {
      const percent = Math.round((signal.score / signal.maxScore) * 100);
      return `<div class="signal">
        <div class="signal-head"><span>${escapeHtml(signal.label)}</span><strong>${signal.score}/${signal.maxScore}</strong></div>
        <div class="meter" role="img" aria-label="${escapeHtml(signal.label)} ${percent}%"><span style="width:${percent}%"></span></div>
        <div class="signal-detail">${escapeHtml(signal.detail)}</div>
      </div>`;
    })
    .join('');
  return `<section class="assessment">
    <div class="section-heading"><div><h2>Why this impact level?</h2><div class="note">Risk level describes change impact; evidence confidence describes how complete the indexed evidence is.</div></div><span class="confidence">Evidence confidence: <strong>${confidenceLabel(analysis)}</strong></span></div>
    <div class="signals">${signals}</div>
    <details class="calculation"><summary>How is this calculated?</summary><p>Risk thresholds: LOW &lt; ${IMPACT_RISK_THRESHOLDS.medium}, MEDIUM ${IMPACT_RISK_THRESHOLDS.medium}–${IMPACT_RISK_THRESHOLDS.high - 1}, HIGH ${IMPACT_RISK_THRESHOLDS.high}–${IMPACT_RISK_THRESHOLDS.critical - 1}, CRITICAL ≥ ${IMPACT_RISK_THRESHOLDS.critical}.</p><div class="formula">${signals}</div><strong>Total risk score: ${assessment.score}/${assessment.maxScore}</strong></details>
    <div class="recommendation"><span class="recommendation-icon">→</span><div><strong>Recommended next step</strong><div>${escapeHtml(assessment.recommendation)}</div></div></div>
  </section>`;
}

function pathsSection(analysis?: ImpactAnalysis): string {
  if (!analysis) return '';
  const changed = analysis.changedFiles.slice(0, 8);
  const dependents = analysis.nodes
    .filter((node) => node.kind === 'dependent')
    .slice(0, 8)
    .map((node) => node.path);
  const tests = analysis.affectedTests.slice(0, 8);
  const dependentCount = analysis.dependentFiles?.length ?? analysis.totalDependentsTraversed;
  const list = (values: string[], empty: string) =>
    values.length > 0
      ? `<ul>${values.map((value) => `<li><code>${escapeHtml(value)}</code></li>`).join('')}</ul>`
      : `<div class="muted">${empty}</div>`;
  return `<section class="path-summary">
    <div class="section-heading"><div><h2>What can be affected?</h2><div class="note">Showing the first 8 paths in each group. The counters above include the full result.</div></div></div>
    <div class="path-columns">
      <div class="path-group changed"><h3>Changed · ${metric(analysis.changedFiles.length)}</h3>${list(changed, 'No changed files')}</div>
      <div class="path-group dependent"><h3>Dependent workflows · ${metric(dependentCount)}</h3>${list(dependents, 'No dependent path surfaced in graph context')}${blastRadiusDetails(analysis)}</div>
      <div class="path-group test"><h3>Affected tests · ${metric(analysis.affectedTests.length)}</h3>${list(tests, 'No indexed affected tests')}</div>
    </div>
  </section>`;
}

function graphSvg(analysis?: ImpactAnalysis): string {
  if (!analysis || analysis.nodes.length === 0) {
    return '<div class="empty">Run “Analyze Change Impact” to build the workflow graph.</div>';
  }

  const columns: Record<ImpactNode['kind'], ImpactNode[]> = {
    changed: analysis.nodes.filter((node) => node.kind === 'changed').slice(0, 8),
    dependent: analysis.nodes
      .filter((node) => node.kind === 'dependent')
      .slice(0, 12),
    test: analysis.nodes.filter((node) => node.kind === 'test').slice(0, 8),
  };
  const x: Record<ImpactNode['kind'], number> = {
    changed: 145,
    dependent: 480,
    test: 815,
  };
  const positions = new Map<string, { x: number; y: number }>();
  const visible: ImpactNode[] = [];
  for (const kind of ['changed', 'dependent', 'test'] as const) {
    columns[kind].forEach((node, index) => {
      positions.set(node.id, { x: x[kind], y: 85 + index * 70 });
      visible.push(node);
    });
  }
  const height = Math.max(
    310,
    ...Object.values(columns).map((nodes) => nodes.length * 70 + 100),
  );

  const edgeMarkup = analysis.edges
    .map((edge) => {
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      if (!source || !target) return '';
      return `<path class="edge" data-source="${escapeHtml(edge.source)}" data-target="${escapeHtml(edge.target)}" marker-end="url(#arrow)" d="M ${source.x + 112} ${source.y} C ${source.x + 190} ${source.y}, ${target.x - 190} ${target.y}, ${target.x - 112} ${target.y}"><title>${escapeHtml(edge.label)}</title></path>`;
    })
    .join('');
  const nodeMarkup = visible
    .map((node) => {
      const point = positions.get(node.id);
      if (!point) return '';
      return `<g class="node ${node.kind}" transform="translate(${point.x - 112},${point.y - 25})" data-node-id="${escapeHtml(node.id)}" data-kind="${node.kind}" data-path="${escapeHtml(node.path)}" data-line="${node.line ?? 1}" tabindex="0" role="button">
        <rect width="224" height="50" rx="10"></rect>
        <text x="112" y="22" text-anchor="middle">${escapeHtml(node.label.slice(0, 28))}</text>
        <text class="kind" x="112" y="39" text-anchor="middle">${node.kind}</text>
        <title>${escapeHtml(node.path)}</title>
      </g>`;
    })
    .join('');

  return `<svg class="graph" viewBox="0 0 960 ${height}" role="img" aria-label="Change impact workflow graph">
    <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker></defs>
    <text class="column-title" x="145" y="30" text-anchor="middle">Changed</text>
    <text class="column-title" x="480" y="30" text-anchor="middle">Dependents</text>
    <text class="column-title" x="815" y="30" text-anchor="middle">Affected tests</text>
    ${edgeMarkup}${nodeMarkup}
  </svg>`;
}

function graphToolbar(analysis?: ImpactAnalysis): string {
  if (!analysis || analysis.nodes.length === 0) return '';
  return `<div class="graph-toolbar" role="toolbar" aria-label="Filter impact graph">
    <span class="toolbar-label">Show</span>
    <button class="filter active" data-graph-filter="all" aria-pressed="true">All</button>
    <button class="filter" data-graph-filter="changed" aria-pressed="false">Changed</button>
    <button class="filter" data-graph-filter="dependent" aria-pressed="false">Dependents</button>
    <button class="filter" data-graph-filter="test" aria-pressed="false">Tests</button>
  </div>`;
}

export function panelHtml(
  webview: vscode.Webview,
  analysis: ImpactAnalysis | undefined,
  snapshot: TokenSavingSnapshot,
  nativeKernel: boolean,
): string {
  const scriptNonce = nonce();
  const risk = analysis?.risk ?? 'not analyzed';
  const score = riskScore(analysis);
  const last = analysis?.metrics ?? snapshot.last;
  // Older stored snapshots predate this counter; treat a missing value as none
  // measured rather than rendering NaN.
  const measuredAnalyses = snapshot.measuredAnalyses ?? 0;
  const latestRequest = snapshot.lastChatRequest;
  const latestRequestSection = latestRequest
    ? `<h2>Latest chat request · estimated</h2>
  <section class="cards">
    <div class="card"><div class="label">Command</div><div class="value">/${escapeHtml(latestRequest.command)}</div></div>
    <div class="card"><div class="label">Model</div><div class="value compact">${escapeHtml(latestRequest.model)}</div></div>
    <div class="card"><div class="label">CodeBrain context</div><div class="value">${metric(latestRequest.codeBrainContextTokens)}</div></div>
    <div class="card"><div class="label">Model input</div><div class="value">${metric(latestRequest.inputTokens)}</div></div>
    <div class="card"><div class="label">Model output</div><div class="value">${metric(latestRequest.outputTokens)}</div></div>
    <div class="card"><div class="label">Request total</div><div class="value">${metric(latestRequest.totalTokens)}</div></div>
    <div class="card"><div class="label">Request latency</div><div class="value">${metric(latestRequest.latencyMs)} ms</div></div>
  </section>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
  <title>CodeBrain Impact</title>
  <style>
    :root { color-scheme: light dark; }
    body { padding: 22px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); background: var(--vscode-editor-background); }
    header { display:flex; justify-content:space-between; gap:16px; align-items:center; margin-bottom:18px; }
    h1 { font-size:22px; margin:0; } h2 { font-size:16px; margin:24px 0 0; } .subtitle { color:var(--vscode-descriptionForeground); margin-top:5px; }
    button { border:1px solid var(--vscode-button-border, transparent); border-radius:5px; padding:7px 11px; color:var(--vscode-button-foreground); background:var(--vscode-button-background); cursor:pointer; }
    button.secondary { color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); }
    .actions { display:flex; flex-wrap:wrap; gap:8px; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:16px 0; }
    .card { border:1px solid var(--vscode-panel-border); border-radius:9px; padding:13px; background:var(--vscode-sideBar-background); }
    .hero-card { border-color:var(--vscode-focusBorder); } .card .label { color:var(--vscode-descriptionForeground); font-size:12px; } .card .value { font-size:21px; font-weight:650; margin-top:6px; } .card .value.compact { font-size:15px; overflow-wrap:anywhere; } .score { color:var(--vscode-descriptionForeground); font-size:13px; font-weight:500; }
    .risk { text-transform:uppercase; } .risk.high,.risk.critical { color:var(--vscode-errorForeground); } .risk.medium { color:var(--vscode-editorWarning-foreground); } .risk.low { color:var(--vscode-testing-iconPassed); }
    .impact-description { margin:-7px 0 17px; color:var(--vscode-descriptionForeground); font-size:13px; line-height:1.45; }
    .evidence-banner { display:flex; gap:10px; align-items:baseline; margin:14px 0; padding:10px 12px; border-left:3px solid var(--vscode-focusBorder); background:var(--vscode-sideBar-background); font-size:12px; line-height:1.45; } .evidence-banner strong { white-space:nowrap; } .evidence-banner span { color:var(--vscode-descriptionForeground); } .evidence-banner.good { border-left-color:var(--vscode-testing-iconPassed); } .evidence-banner.warn { border-left-color:var(--vscode-editorWarning-foreground); } .evidence-banner.quiet { border-left-color:var(--vscode-descriptionForeground); }
    .assessment,.path-summary,.analysis-details { margin:18px 0; padding:16px; border:1px solid var(--vscode-panel-border); border-radius:10px; background:var(--vscode-sideBar-background); }
    .section-heading { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; } .section-heading h2 { margin:0; } .confidence { color:var(--vscode-descriptionForeground); font-size:12px; white-space:nowrap; }
    .signals { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:14px; margin-top:14px; } .signal-head { display:flex; justify-content:space-between; gap:8px; font-size:13px; } .signal-head strong { color:var(--vscode-foreground); }
    .meter { height:5px; margin:7px 0 6px; border-radius:3px; background:var(--vscode-progressBar-background); opacity:.3; overflow:hidden; } .meter span { display:block; height:100%; border-radius:3px; background:var(--vscode-focusBorder); opacity:1; } .signal-detail { color:var(--vscode-descriptionForeground); font-size:11px; line-height:1.35; }
    .recommendation { display:flex; gap:10px; align-items:flex-start; margin-top:16px; padding:11px 12px; border-left:3px solid var(--vscode-charts-blue); background:var(--vscode-editor-background); font-size:12px; line-height:1.45; } .recommendation-icon { color:var(--vscode-charts-blue); font-size:18px; line-height:1; }
    .path-columns { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:14px; margin-top:14px; } .path-group { min-width:0; } .path-group h3 { margin:0 0 8px; font-size:12px; font-weight:650; } .path-group.changed h3 { color:var(--vscode-charts-orange); } .path-group.dependent h3 { color:var(--vscode-charts-blue); } .path-group.test h3 { color:var(--vscode-testing-iconPassed); } ul { list-style:none; padding:0; margin:0; } li { padding:4px 0; overflow-wrap:anywhere; font-size:11px; } code { font-family:var(--vscode-editor-font-family); color:var(--vscode-foreground); } .muted { color:var(--vscode-descriptionForeground); font-size:11px; }
    .graph-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin:18px 0 8px; } .toolbar-label { color:var(--vscode-descriptionForeground); font-size:12px; margin-right:3px; } button.filter { padding:4px 9px; font-size:11px; color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); } button.filter.active { color:var(--vscode-button-foreground); background:var(--vscode-button-background); }
    .surface { border:1px solid var(--vscode-panel-border); border-radius:10px; overflow:auto; background:var(--vscode-editorWidget-background); }
    .graph { min-width:760px; width:100%; max-height:720px; }
    .edge { fill:none; stroke:var(--vscode-descriptionForeground); stroke-width:1.2; opacity:.55; } marker path { fill:var(--vscode-descriptionForeground); }
    .node { cursor:pointer; } .node rect { fill:var(--vscode-editor-background); stroke:var(--vscode-focusBorder); stroke-width:1.2; }
    .node.changed rect { stroke:var(--vscode-charts-orange); } .node.test rect { stroke:var(--vscode-testing-iconPassed); }
    .node text { fill:var(--vscode-foreground); font-size:12px; pointer-events:none; } .node .kind { fill:var(--vscode-descriptionForeground); font-size:9px; text-transform:uppercase; }
    .column-title { fill:var(--vscode-descriptionForeground); font-weight:650; font-size:12px; text-transform:uppercase; }
    .empty { padding:60px 24px; text-align:center; color:var(--vscode-descriptionForeground); }
    .note { color:var(--vscode-descriptionForeground); font-size:12px; margin-top:10px; }
    details { margin-top:14px; } summary { cursor:pointer; color:var(--vscode-textLink-foreground); font-size:12px; font-weight:650; } .calculation p { color:var(--vscode-descriptionForeground); font-size:12px; line-height:1.45; } .formula { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:9px; margin:10px 0; } .formula .signal { padding:9px; border:1px solid var(--vscode-panel-border); border-radius:7px; } .formula .signal-detail { display:none; } .breakdown { display:flex; flex-wrap:wrap; gap:12px; margin:13px 0; font-size:12px; } .blast-details h3 { font-size:12px; margin:14px 0 5px; } .fanout { float:right; color:var(--vscode-descriptionForeground); font-size:11px; } .analysis-details { color:var(--vscode-descriptionForeground); } .analysis-details .cards { margin-bottom:0; }
    @media (max-width:620px) { body { padding:14px; } header { align-items:flex-start; flex-direction:column; } .section-heading { flex-direction:column; } .confidence { white-space:normal; } .cards { grid-template-columns:repeat(2,minmax(0,1fr)); } .card .value { font-size:18px; } }
  </style>
</head>
<body>
  <header>
    <div><h1>CodeBrain Change Impact</h1><div class="subtitle">Risk and evidence summary for review and merge decisions</div></div>
    <div class="actions">
      <button data-command="analyze">Analyze Change Impact</button>
      ${(analysis?.affectedTests.length ?? 0) > 0 ? `<button data-command="runTests">Run ${metric(analysis?.affectedTests.length ?? 0)} Affected Test${(analysis?.affectedTests.length ?? 0) === 1 ? '' : 's'}</button>` : ''}
      <button class="secondary" data-command="markdown">Export Markdown</button>
    </div>
  </header>
  <section class="cards" aria-label="Risk summary">
    <div class="card hero-card"><div class="label">Impact level</div><div class="value risk ${escapeHtml(risk)}">${escapeHtml(risk)} <span class="score">${escapeHtml(score)}</span></div></div>
    <div class="card"><div class="label">Changed files</div><div class="value">${metric(analysis?.changedFiles.length ?? 0)}</div></div>
    <div class="card"><div class="label">Dependent workflows</div><div class="value">${metric(analysis?.dependentFiles?.length ?? analysis?.totalDependentsTraversed ?? 0)}</div></div>
    <div class="card"><div class="label">Affected tests</div><div class="value">${metric(analysis?.affectedTests.length ?? last?.affectedTests ?? 0)}</div></div>
    <div class="card"><div class="label">Test status</div><div class="value compact">${escapeHtml(coverageLabel(analysis))}</div></div>
    <div class="card"><div class="label">Evidence confidence</div><div class="value compact">${escapeHtml(confidenceLabel(analysis))}</div></div>
  </section>
  <div class="impact-description">${escapeHtml(impactDescription(analysis))}</div>
  ${truncationBanner(analysis)}
  ${evidenceBanner(analysis)}
  ${assessmentSection(analysis)}
  ${pathsSection(analysis)}
  ${graphToolbar(analysis)}
  <section class="surface">${graphSvg(analysis)}</section>
  <div class="note">Click a graph node to open its source file. Graph relationships are grouped from indexed evidence.</div>
  <details class="analysis-details"><summary>Analysis details</summary>
    <div class="cards">
      <div class="card"><div class="label">Extraction engine</div><div class="value compact">${nativeKernel ? 'Rust native' : 'WASM fallback'}</div></div>
      <div class="card"><div class="label">Last latency</div><div class="value">${metric(last?.latencyMs ?? 0)} ms</div></div>
      <div class="card"><div class="label">File reads avoided · measured</div><div class="value">${measuredAnalyses > 0 ? metric(snapshot.totalFileReadsAvoided) : 'n/a'}</div></div>
      <div class="card"><div class="label">Tokens saved · measured</div><div class="value">${measuredAnalyses > 0 ? metric(snapshot.totalTokensSaved) : 'n/a'}</div></div>
      <div class="card"><div class="label">Analyses</div><div class="value">${metric(snapshot.analyses)}</div></div>
      <div class="card"><div class="label">Of those, measurable</div><div class="value">${metric(measuredAnalyses)}</div></div>
    </div>
    <div class="note">Totals cover only the ${metric(measuredAnalyses)} analyses whose baseline could be measured from real file sizes on disk (4 bytes &asymp; 1 token). They are not model billing data.</div>${latestRequestSection || ''}
  </details>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command })));
    const graphNodes = Array.from(document.querySelectorAll('.node'));
    const graphEdges = Array.from(document.querySelectorAll('.edge'));
    document.querySelectorAll('[data-graph-filter]').forEach((button) => button.addEventListener('click', () => {
      const filter = button.dataset.graphFilter || 'all';
      const visible = new Set(graphNodes.filter((node) => filter === 'all' || node.dataset.kind === filter).map((node) => node.dataset.nodeId));
      graphNodes.forEach((node) => { node.style.display = visible.has(node.dataset.nodeId) ? '' : 'none'; });
      graphEdges.forEach((edge) => { edge.style.display = visible.has(edge.dataset.source) && visible.has(edge.dataset.target) ? '' : 'none'; });
      document.querySelectorAll('[data-graph-filter]').forEach((item) => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); });
    }));
    graphNodes.forEach((node) => {
      const open = () => vscode.postMessage({ command: 'openFile', path: node.dataset.path, line: Number(node.dataset.line || 1) });
      node.addEventListener('click', open);
      node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') open(); });
    });
  </script>
</body>
</html>`;
}

export class WorkflowGraphPanel implements vscode.Disposable {
  private static current: WorkflowGraphPanel | undefined;
  private analysis?: ImpactAnalysis;

  public static show(
    extensionUri: vscode.Uri,
    analysis: ImpactAnalysis | undefined,
    snapshot: TokenSavingSnapshot,
    nativeKernel: boolean,
  ): WorkflowGraphPanel {
    if (WorkflowGraphPanel.current) {
      WorkflowGraphPanel.current.analysis = analysis ?? WorkflowGraphPanel.current.analysis;
      WorkflowGraphPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      WorkflowGraphPanel.current.nativeKernel = nativeKernel;
      WorkflowGraphPanel.current.render(snapshot);
      return WorkflowGraphPanel.current;
    }
    WorkflowGraphPanel.current = new WorkflowGraphPanel(
      extensionUri,
      analysis,
      snapshot,
      nativeKernel,
    );
    return WorkflowGraphPanel.current;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private nativeKernel: boolean;

  private constructor(
    _extensionUri: vscode.Uri,
    analysis: ImpactAnalysis | undefined,
    snapshot: TokenSavingSnapshot,
    nativeKernel: boolean,
  ) {
    this.analysis = analysis;
    this.nativeKernel = nativeKernel;
    this.panel = vscode.window.createWebviewPanel(
      'codebrain.workflowGraph',
      'CodeBrain Impact',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.iconPath = undefined;
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: { command?: string; path?: string; line?: number }) =>
        this.handleMessage(message),
      undefined,
      this.disposables,
    );
    this.render(snapshot);
  }

  public dispose(): void {
    WorkflowGraphPanel.current = undefined;
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private render(snapshot: TokenSavingSnapshot): void {
    this.panel.webview.html = panelHtml(
      this.panel.webview,
      this.analysis,
      snapshot,
      this.nativeKernel,
    );
  }

  private async handleMessage(message: {
    command?: string;
    path?: string;
    line?: number;
  }): Promise<void> {
    if (message.command === 'analyze') {
      await vscode.commands.executeCommand('codebrain.analyzeImpact');
      return;
    }
    if (message.command === 'markdown') {
      await vscode.commands.executeCommand('codebrain.exportLatestMarkdown');
      return;
    }
    if (message.command === 'runTests') {
      await vscode.commands.executeCommand(
        'codebrain.runAffectedTests',
        this.analysis
          ? { root: this.analysis.root, tests: this.analysis.affectedTests }
          : undefined,
      );
      return;
    }
    if (
      message.command === 'openFile' &&
      message.path &&
      this.analysis
    ) {
      const root = resolve(this.analysis.root);
      const target = resolve(root, message.path);
      if (target !== root && !target.startsWith(`${root}${sep}`)) {
        void vscode.window.showErrorMessage(
          'CodeBrain refused to open a graph path outside the workspace.',
        );
        return;
      }
      const uri = vscode.Uri.file(target);
      const document = await vscode.workspace.openTextDocument(uri);
      const line = Math.min(
        Math.max(0, (message.line ?? 1) - 1),
        Math.max(0, document.lineCount - 1),
      );
      await vscode.window.showTextDocument(document, {
        selection: new vscode.Range(line, 0, line, 0),
        preview: true,
      });
    }
  }
}
