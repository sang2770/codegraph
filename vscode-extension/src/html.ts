import { randomBytes } from 'node:crypto';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/** Per-render nonce for the webview's `script-src` policy. */
export function nonce(): string {
  return randomBytes(16).toString('hex');
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Shared webview styling so every CodeBrain panel reads as one surface. */
export const PANEL_STYLES = `
  :root { color-scheme: light dark; }
  body { padding:22px; color:var(--vscode-foreground); font-family:var(--vscode-font-family); background:var(--vscode-editor-background); }
  header { display:flex; justify-content:space-between; gap:16px; align-items:center; margin-bottom:18px; }
  h1 { font-size:22px; margin:0; } h2 { font-size:16px; margin:24px 0 8px; }
  .subtitle { color:var(--vscode-descriptionForeground); margin-top:5px; }
  button { border:1px solid var(--vscode-button-border, transparent); border-radius:5px; padding:7px 11px; color:var(--vscode-button-foreground); background:var(--vscode-button-background); cursor:pointer; }
  button.secondary { color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); }
  .actions { display:flex; flex-wrap:wrap; gap:8px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:16px 0; }
  .card { border:1px solid var(--vscode-panel-border); border-radius:9px; padding:13px; background:var(--vscode-sideBar-background); }
  .card .label { color:var(--vscode-descriptionForeground); font-size:12px; }
  .card .value { font-size:21px; font-weight:650; margin-top:6px; }
  .card .value.compact { font-size:15px; overflow-wrap:anywhere; }
  .warn-list { margin:14px 0; padding:0; list-style:none; }
  .warn-list li { padding:10px 12px; margin-bottom:8px; border-left:3px solid var(--vscode-editorWarning-foreground); background:var(--vscode-sideBar-background); font-size:12px; line-height:1.45; }
  .ok { padding:10px 12px; margin:14px 0; border-left:3px solid var(--vscode-testing-iconPassed); background:var(--vscode-sideBar-background); font-size:12px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--vscode-panel-border); }
  th { color:var(--vscode-descriptionForeground); font-weight:650; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  code { font-family:var(--vscode-editor-font-family); }
  .note { color:var(--vscode-descriptionForeground); font-size:12px; margin-top:10px; line-height:1.5; }
  .muted { color:var(--vscode-descriptionForeground); font-size:11px; }
  section.block { margin:18px 0; padding:16px; border:1px solid var(--vscode-panel-border); border-radius:10px; background:var(--vscode-sideBar-background); }
  details { margin-top:14px; } summary { cursor:pointer; color:var(--vscode-textLink-foreground); font-size:12px; font-weight:650; }
`;
