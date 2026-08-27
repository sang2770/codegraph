/**
 * The board's HTML shell.
 *
 * Deliberately static: the shell is written once per webview and every value
 * on screen is drawn afterwards by `media/jira-board.js` from a posted view.
 * That split is what keeps the search box's caret and the scroll position
 * alive across a re-filter — replacing the document on each keystroke would
 * lose both.
 *
 * The only difference between the sidebar view and the editor panel is the
 * `layout-*` class on `<body>` and the presence of the "Open full board"
 * button; one stylesheet covers both densities.
 */

import * as vscode from 'vscode';
import { nonce } from '../html';

export type BoardLayout = 'sidebar' | 'panel';

const SCOPES: readonly { id: string; label: string; title: string }[] = [
  { id: 'mine', label: 'Mine', title: 'Issues assigned to you' },
  { id: 'reported', label: 'Reported', title: 'Issues you reported' },
  { id: 'watched', label: 'Watching', title: 'Issues you watch' },
  { id: 'all', label: 'Everyone', title: 'Every issue the query matches' },
];

const CATEGORIES: readonly { id: string; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'inprogress', label: 'In progress' },
  { id: 'done', label: 'Done' },
];

const DUE_OPTIONS: readonly { id: string; label: string }[] = [
  { id: 'any', label: 'Any due date' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Due today' },
  { id: 'week', label: 'Due this week' },
  { id: 'none', label: 'No due date' },
];

const SORT_OPTIONS: readonly { id: string; label: string }[] = [
  { id: 'due', label: 'Due date' },
  { id: 'priority', label: 'Priority' },
  { id: 'updated', label: 'Recently updated' },
  { id: 'status', label: 'Status' },
  { id: 'key', label: 'Newest key' },
];

function scopeChips(): string {
  return SCOPES.map(
    (scope) =>
      `<button type="button" class="chip" data-scope="${scope.id}" aria-pressed="false" title="${scope.title}">${scope.label}<span class="count"></span></button>`,
  ).join('');
}

/** Progress chips carry the column's colour as a leading dot. */
function categoryChips(): string {
  return CATEGORIES.map(
    (category) =>
      `<button type="button" class="chip dot cat-${category.id}" data-category="${category.id}" aria-pressed="false">${category.label}<span class="count"></span></button>`,
  ).join('');
}

function options(entries: readonly { id: string; label: string }[]): string {
  return entries.map((entry) => `<option value="${entry.id}">${entry.label}</option>`).join('');
}

export function boardHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  layout: BoardLayout,
): string {
  const scriptNonce = nonce();
  const styles = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'jira-board.css'),
  );
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'jira-board.js'),
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${scriptNonce}';">
  <link rel="stylesheet" href="${styles}">
  <title>CodeBrain Jira Board</title>
</head>
<body class="layout-${layout}">
  <div class="top">
    <div class="titles">
      <h1>Jira Board</h1>
      <div class="subtitle" id="subtitle"></div>
    </div>
    <div class="actions">
      ${layout === 'sidebar' ? '<button type="button" class="ghost" id="openBoard" title="Open the full board with charts in an editor tab">Full board</button>' : ''}
      <button type="button" class="ghost" id="refresh" title="Reload from Jira">Refresh</button>
      <button type="button" class="ghost" id="fetch" title="git fetch, so branches teammates pushed show up">Fetch branches</button>
      <button type="button" class="ghost" id="reset" title="Back to the default filters">Reset</button>
    </div>
  </div>

  <div class="loading-bar hidden" id="loading" role="progressbar" aria-label="Loading issues"></div>
  <div class="error hidden" id="error" role="alert"></div>
  <div id="banner"></div>

  <div class="toolbar" role="group" aria-label="Board filters">
    <div class="filter-row">
      <span class="label">Who</span>
      ${scopeChips()}
    </div>
    <div class="filter-row">
      <span class="label">Progress</span>
      ${categoryChips()}
    </div>
    <div class="filter-row hidden">
      <span class="label">Status</span>
      <span id="statusChips" class="filter-row"></span>
    </div>
    <div class="filter-row">
      <select id="due" aria-label="Due date filter">${options(DUE_OPTIONS)}</select>
      <select id="sort" aria-label="Sort order">${options(SORT_OPTIONS)}</select>
      <input type="text" id="projects" placeholder="Project keys" aria-label="Project keys, comma separated" size="12" title="Limit the board to these Jira project keys, for example TPLD, WEB">
      <label class="label" title="Only issues in a sprint that is currently open"><input type="checkbox" id="sprint"> Open sprints</label>
      <input type="search" id="search" class="search" placeholder="Filter by key, summary, label…" aria-label="Filter loaded issues">
    </div>
  </div>

  <div class="warning-tiles" id="warnings" role="group" aria-label="Warnings"></div>
  <div id="stats"></div>
  <div id="board"></div>
  <div class="footer" id="footer"></div>

  <script nonce="${scriptNonce}" src="${script}"></script>
</body>
</html>`;
}
