import { resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ImpactAnalysis, ImpactNode } from './impact';
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
      return `<path class="edge" marker-end="url(#arrow)" d="M ${source.x + 112} ${source.y} C ${source.x + 190} ${source.y}, ${target.x - 190} ${target.y}, ${target.x - 112} ${target.y}"><title>${escapeHtml(edge.label)}</title></path>`;
    })
    .join('');
  const nodeMarkup = visible
    .map((node) => {
      const point = positions.get(node.id);
      if (!point) return '';
      return `<g class="node ${node.kind}" transform="translate(${point.x - 112},${point.y - 25})" data-path="${escapeHtml(node.path)}" data-line="${node.line ?? 1}" tabindex="0" role="button">
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

function panelHtml(
  webview: vscode.Webview,
  analysis: ImpactAnalysis | undefined,
  snapshot: TokenSavingSnapshot,
  nativeKernel: boolean,
): string {
  const scriptNonce = nonce();
  const risk = analysis?.risk ?? 'not analyzed';
  const last = analysis?.metrics ?? snapshot.last;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
  <title>CodeGraph Impact</title>
  <style>
    :root { color-scheme: light dark; }
    body { padding: 22px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); background: var(--vscode-editor-background); }
    header { display:flex; justify-content:space-between; gap:16px; align-items:center; margin-bottom:18px; }
    h1 { font-size:22px; margin:0; } .subtitle { color:var(--vscode-descriptionForeground); margin-top:5px; }
    button { border:1px solid var(--vscode-button-border, transparent); border-radius:5px; padding:7px 11px; color:var(--vscode-button-foreground); background:var(--vscode-button-background); cursor:pointer; }
    button.secondary { color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); }
    .actions { display:flex; flex-wrap:wrap; gap:8px; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:16px 0; }
    .card { border:1px solid var(--vscode-panel-border); border-radius:9px; padding:13px; background:var(--vscode-sideBar-background); }
    .card .label { color:var(--vscode-descriptionForeground); font-size:12px; } .card .value { font-size:21px; font-weight:650; margin-top:6px; }
    .risk { text-transform:uppercase; } .risk.high,.risk.critical { color:var(--vscode-errorForeground); } .risk.medium { color:var(--vscode-editorWarning-foreground); } .risk.low { color:var(--vscode-testing-iconPassed); }
    .surface { border:1px solid var(--vscode-panel-border); border-radius:10px; overflow:auto; background:var(--vscode-editorWidget-background); }
    .graph { min-width:760px; width:100%; max-height:720px; }
    .edge { fill:none; stroke:var(--vscode-descriptionForeground); stroke-width:1.2; opacity:.55; } marker path { fill:var(--vscode-descriptionForeground); }
    .node { cursor:pointer; } .node rect { fill:var(--vscode-editor-background); stroke:var(--vscode-focusBorder); stroke-width:1.2; }
    .node.changed rect { stroke:var(--vscode-charts-orange); } .node.test rect { stroke:var(--vscode-testing-iconPassed); }
    .node text { fill:var(--vscode-foreground); font-size:12px; pointer-events:none; } .node .kind { fill:var(--vscode-descriptionForeground); font-size:9px; text-transform:uppercase; }
    .column-title { fill:var(--vscode-descriptionForeground); font-weight:650; font-size:12px; text-transform:uppercase; }
    .empty { padding:60px 24px; text-align:center; color:var(--vscode-descriptionForeground); }
    .note { color:var(--vscode-descriptionForeground); font-size:12px; margin-top:10px; }
  </style>
</head>
<body>
  <header>
    <div><h1>CodeGraph Change Impact</h1><div class="subtitle">Workflow graph and estimated token savings from local graph queries</div></div>
    <div class="actions">
      <button data-command="analyze">Analyze Change Impact</button>
      <button class="secondary" data-command="markdown">Export Markdown</button>
      <button class="secondary" data-command="pdf">Export PDF</button>
    </div>
  </header>
  <section class="cards">
    <div class="card"><div class="label">Risk</div><div class="value risk ${escapeHtml(risk)}">${escapeHtml(risk)}</div></div>
    <div class="card"><div class="label">Affected tests</div><div class="value">${metric(analysis?.affectedTests.length ?? last?.affectedTests ?? 0)}</div></div>
    <div class="card"><div class="label">Tokens saved · estimated</div><div class="value">${metric(snapshot.totalTokensSaved)}</div></div>
    <div class="card"><div class="label">File reads avoided · estimated</div><div class="value">${metric(snapshot.totalFileReadsAvoided)}</div></div>
    <div class="card"><div class="label">Analyses</div><div class="value">${metric(snapshot.analyses)}</div></div>
    <div class="card"><div class="label">Last latency</div><div class="value">${metric(last?.latencyMs ?? 0)} ms</div></div>
    <div class="card"><div class="label">Extraction engine</div><div class="value">${nativeKernel ? 'Rust native' : 'WASM fallback'}</div></div>
  </section>
  <section class="surface">${graphSvg(analysis)}</section>
  <div class="note">Click a graph node to open its source file. Token values are estimates, not model billing data.</div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command })));
    document.querySelectorAll('.node').forEach((node) => {
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
      'codegraph.workflowGraph',
      'CodeGraph Impact',
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
      await vscode.commands.executeCommand('codegraph.analyzeImpact');
      return;
    }
    if (message.command === 'markdown') {
      await vscode.commands.executeCommand('codegraph.exportLatestMarkdown');
      return;
    }
    if (message.command === 'pdf') {
      await vscode.commands.executeCommand('codegraph.exportLatestPdf');
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
          'CodeGraph refused to open a graph path outside the workspace.',
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
