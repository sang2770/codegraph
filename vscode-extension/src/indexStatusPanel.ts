import * as vscode from 'vscode';
import {
  escapeHtml,
  formatBytes,
  formatNumber,
  nonce,
  PANEL_STYLES,
} from './html';
import { CoverageReport, IndexStatus, statusWarnings } from './indexStatus';

export interface StatusView {
  root: string;
  status: IndexStatus;
  coverage?: CoverageReport;
}

function warningsSection(status: IndexStatus): string {
  const warnings = statusWarnings(status);
  if (warnings.length === 0) {
    return `<div class="ok"><strong>Index is healthy.</strong> The last run completed, every reference is resolved, and the working tree matches the index.</div>`;
  }
  return `<ul class="warn-list">${warnings
    .map((warning) => `<li>${escapeHtml(warning)}</li>`)
    .join('')}</ul>`;
}

function languageTable(coverage?: CoverageReport): string {
  if (!coverage || coverage.languages.length === 0) {
    return '<div class="muted">No per-language breakdown available.</div>';
  }
  const rows = coverage.languages
    .map(
      (language) => `<tr>
        <td><code>${escapeHtml(language.language)}</code></td>
        <td class="num">${formatNumber(language.files)}</td>
        <td class="num">${formatNumber(language.symbols)}</td>
        <td class="num">${language.filesWithoutSymbols > 0 ? formatNumber(language.filesWithoutSymbols) : '—'}</td>
      </tr>`,
    )
    .join('');
  return `<table>
    <thead><tr><th>Language</th><th class="num">Files</th><th class="num">Symbols</th><th class="num">Tracked only</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="note"><strong>Tracked only</strong> counts files that are in the index but had no symbols extracted. CodeBrain notices when they change, but they cannot appear inside a call path, so a workflow that runs through them will look shorter than it is.</div>`;
}

function gapSection(coverage?: CoverageReport): string {
  if (!coverage) {
    return `<div class="muted">Coverage comparison was not run.</div>`;
  }
  if (coverage.unindexedTotal === 0) {
    return `<div class="ok"><strong>No coverage gap found.</strong> Every workspace file that VS Code's search can see is present in the index.</div>`;
  }
  const rows = coverage.unindexed
    .slice(0, 15)
    .map(
      (entry) => `<tr><td><code>${escapeHtml(entry.extension)}</code></td><td class="num">${formatNumber(entry.files)}</td></tr>`,
    )
    .join('');
  return `<ul class="warn-list"><li><strong>${formatNumber(coverage.unindexedTotal)} workspace file(s) are not in the index.</strong> Files CodeBrain cannot parse are absent from the graph, so any impact analysis or call path that should have crossed them is incomplete — with no error to tell you.</li></ul>
  <table>
    <thead><tr><th>Extension</th><th class="num">Files not indexed</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${coverage.unindexed.length > 15 ? `<div class="muted">Showing the 15 largest of ${formatNumber(coverage.unindexed.length)} extensions.</div>` : ''}
  ${coverage.incomplete ? '<div class="note">The scan was capped, so this is a lower bound — the real gap may be larger.</div>' : ''}
  <div class="note">Not every unindexed file is a problem: assets, lock files, and documentation are expected to be absent. It matters when a <em>source</em> language you rely on appears here.</div>`;
}

export function statusPanelHtml(webview: vscode.Webview, view: StatusView): string {
  const scriptNonce = nonce();
  const { status, coverage } = view;
  const pending =
    status.pendingChanges.added +
    status.pendingChanges.modified +
    status.pendingChanges.removed;
  const lastIndexed = status.lastIndexed
    ? new Date(status.lastIndexed).toLocaleString()
    : 'Never';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
  <title>CodeBrain Index Status</title>
  <style>${PANEL_STYLES}</style>
</head>
<body>
  <header>
    <div><h1>CodeBrain Index Status</h1><div class="subtitle">${escapeHtml(view.root)}</div></div>
    <div class="actions">
      <button data-command="refresh">Refresh Index</button>
      <button class="secondary" data-command="rebuild">Rebuild Index</button>
      <button class="secondary" data-command="reload">Reload Status</button>
    </div>
  </header>

  ${warningsSection(status)}

  <section class="cards" aria-label="Index summary">
    <div class="card"><div class="label">Files indexed</div><div class="value">${formatNumber(status.fileCount)}</div></div>
    <div class="card"><div class="label">Symbols</div><div class="value">${formatNumber(status.nodeCount)}</div></div>
    <div class="card"><div class="label">Relationships</div><div class="value">${formatNumber(status.edgeCount)}</div></div>
    <div class="card"><div class="label">Unsynced changes</div><div class="value">${formatNumber(pending)}</div></div>
    <div class="card"><div class="label">Index size</div><div class="value compact">${formatBytes(status.dbSizeBytes)}</div></div>
    <div class="card"><div class="label">Last indexed</div><div class="value compact">${escapeHtml(lastIndexed)}</div></div>
  </section>

  <section class="block">
    <h2>What CodeBrain can see</h2>
    ${languageTable(coverage)}
  </section>

  <section class="block">
    <h2>Coverage gaps</h2>
    ${gapSection(coverage)}
  </section>

  <details>
    <summary>Runtime details</summary>
    <div class="cards">
      <div class="card"><div class="label">Engine version</div><div class="value compact">${escapeHtml(status.version ?? 'unknown')}</div></div>
      <div class="card"><div class="label">Index built with</div><div class="value compact">${escapeHtml(status.index.builtWithVersion ?? 'unknown')}</div></div>
      <div class="card"><div class="label">Last run state</div><div class="value compact">${escapeHtml(status.index.state ?? 'unknown')}</div></div>
      <div class="card"><div class="label">Storage backend</div><div class="value compact">${escapeHtml(status.backend ?? 'unknown')}</div></div>
      <div class="card"><div class="label">Journal mode</div><div class="value compact">${escapeHtml(status.journalMode ?? 'unknown')}</div></div>
      <div class="card"><div class="label">Unresolved references</div><div class="value">${formatNumber(status.index.pendingRefs)}</div></div>
    </div>
  </details>

  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-command]').forEach((button) =>
      button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command })));
  </script>
</body>
</html>`;
}

export class IndexStatusPanel implements vscode.Disposable {
  private static current: IndexStatusPanel | undefined;

  public static show(view: StatusView, reload: () => void): IndexStatusPanel {
    if (IndexStatusPanel.current) {
      IndexStatusPanel.current.reload = reload;
      IndexStatusPanel.current.render(view);
      IndexStatusPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return IndexStatusPanel.current;
    }
    IndexStatusPanel.current = new IndexStatusPanel(view, reload);
    return IndexStatusPanel.current;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    view: StatusView,
    private reload: () => void,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'codebrain.indexStatus',
      'CodeBrain Index Status',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: { command?: string }) => this.handleMessage(message),
      undefined,
      this.disposables,
    );
    this.render(view);
  }

  public dispose(): void {
    IndexStatusPanel.current = undefined;
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private render(view: StatusView): void {
    this.panel.webview.html = statusPanelHtml(this.panel.webview, view);
  }

  private async handleMessage(message: { command?: string }): Promise<void> {
    if (message.command === 'refresh') {
      await vscode.commands.executeCommand('codebrain.syncIndex');
      this.reload();
      return;
    }
    if (message.command === 'rebuild') {
      await vscode.commands.executeCommand('codebrain.rebuildIndex');
      this.reload();
      return;
    }
    if (message.command === 'reload') {
      this.reload();
    }
  }
}
