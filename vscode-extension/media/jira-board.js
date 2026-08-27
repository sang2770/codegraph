/*
 * Client for the CodeBrain Jira board webview.
 *
 * The extension owns the data and the filtering: it posts a fully composed
 * view (`{ type: 'state', view }`) and this script draws it. Only the regions
 * that actually change are rebuilt, and the toolbar's inputs are never written
 * to while they have focus — that is what keeps typing in the search box from
 * losing the caret on every keystroke.
 *
 * Nothing here builds HTML from strings: every node is created and filled with
 * textContent, so an issue summary can contain anything at all.
 */

// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();

  const CATEGORY_LABELS = { todo: 'To do', inprogress: 'In progress', done: 'Done' };
  const CATEGORY_COLOR = {
    todo: 'var(--cb-todo)',
    inprogress: 'var(--cb-progress)',
    done: 'var(--cb-done)',
  };
  const WARNING_LABELS = {
    overdue: 'Overdue',
    dueSoon: 'Due soon',
    stale: 'Stale',
    unassigned: 'Unassigned',
    noDueDate: 'No due date',
  };
  const WARNING_SEVERITY = {
    overdue: 'high',
    dueSoon: 'medium',
    stale: 'medium',
    unassigned: 'low',
    noDueDate: 'low',
  };
  const WARNING_HINTS = {
    overdue: 'Past their due date and still open.',
    dueSoon: 'Due within the next few days.',
    stale: 'In progress but untouched for a while.',
    unassigned: 'Open with nobody assigned.',
    noDueDate: 'In progress without a due date.',
  };

  /** @type {any} */
  let view = null;
  let searchTimer = null;

  const byId = (id) => document.getElementById(id);

  function post(command, payload) {
    vscode.postMessage(Object.assign({ command }, payload || {}));
  }

  function setFilters(patch) {
    post('setFilters', { filters: patch });
  }

  function node(tag, className, text) {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined && text !== null) created.textContent = String(text);
    return created;
  }

  function clear(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
    return element;
  }

  function initials(name) {
    const words = String(name || '?')
      .split(/[\s.@_-]+/)
      .filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }

  /** Whole days from today to a `YYYY-MM-DD` due date; positive is future. */
  function daysUntil(dueDate, now) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dueDate || '');
    if (!match) return undefined;
    const due = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const today = new Date(now);
    const midnight = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    return Math.round((due - midnight) / 86400000);
  }

  function dueTag(issue, now) {
    if (!issue.dueDate) return null;
    const days = daysUntil(issue.dueDate, now);
    if (days === undefined) return null;
    let kind = 'later';
    let label = issue.dueDate;
    if (days < 0) {
      kind = 'overdue';
      label = days === -1 ? 'Late 1d' : 'Late ' + Math.abs(days) + 'd';
    } else if (days === 0) {
      kind = 'today';
      label = 'Due today';
    } else if (days <= 7) {
      kind = 'week';
      label = 'Due in ' + days + 'd';
    }
    const tag = node('span', 'tag due-' + kind, label);
    tag.title = 'Due ' + issue.dueDate;
    return tag;
  }

  function priorityTag(priority) {
    if (!priority) return null;
    const normalized = priority.toLowerCase();
    let severity = '';
    if (/blocker|highest|critical|high|major/.test(normalized)) severity = ' prio-high';
    else if (/medium|normal/.test(normalized)) severity = ' prio-medium';
    const tag = node('span', 'tag' + severity, priority);
    tag.title = 'Priority: ' + priority;
    return tag;
  }

  function relativeTime(timestamp) {
    if (!timestamp) return '';
    const at = Date.parse(timestamp);
    if (Number.isNaN(at)) return '';
    const minutes = Math.round((Date.now() - at) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.round(hours / 24) + 'd ago';
  }

  // ------------------------------------------------------------------ toolbar

  /**
   * Reflect the filters onto the static controls.
   *
   * A control the user is currently interacting with is left alone: writing to
   * it mid-render would fight the person typing.
   */
  function syncToolbar(current) {
    const filters = current.filters;

    document.querySelectorAll('[data-scope]').forEach((chip) => {
      chip.setAttribute('aria-pressed', String(chip.dataset.scope === filters.scope));
    });

    document.querySelectorAll('[data-category]').forEach((chip) => {
      const active = filters.categories.indexOf(chip.dataset.category) >= 0;
      chip.setAttribute('aria-pressed', String(active));
      const counts = current.loadedStats.byCategory;
      const count = counts[chip.dataset.category];
      const badge = chip.querySelector('.count');
      if (badge) badge.textContent = active && count ? String(count) : '';
    });

    const controls = [
      ['due', filters.due],
      ['sort', filters.sort],
      ['search', filters.text],
      ['projects', filters.projects],
    ];
    controls.forEach(function (entry) {
      const element = byId(entry[0]);
      if (element && document.activeElement !== element) element.value = entry[1];
    });

    const sprint = byId('sprint');
    if (sprint && document.activeElement !== sprint) sprint.checked = filters.openSprintsOnly;

    renderStatusChips(current);
  }

  function renderStatusChips(current) {
    const host = clear(byId('statusChips'));
    // Exact statuses only earn a row once there is more than one to choose
    // between — otherwise the chip says the same thing as the category.
    if (current.statuses.length < 2) {
      host.parentElement.classList.add('hidden');
      return;
    }
    host.parentElement.classList.remove('hidden');
    current.statuses.forEach(function (status) {
      const active = current.filters.statuses.indexOf(status) >= 0;
      const chip = node('button', 'chip', status);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(active));
      chip.addEventListener('click', function () {
        const next = current.filters.statuses.slice();
        const at = next.indexOf(status);
        if (at >= 0) next.splice(at, 1);
        else next.push(status);
        setFilters({ statuses: next });
      });
      host.appendChild(chip);
    });
  }

  // ------------------------------------------------------------------- banner

  function renderBanner(current) {
    const host = clear(byId('banner'));
    const repository = current.data.repository;
    if (!repository.isRepository) return;

    const banner = node('div', 'banner');
    const grow = node('div', 'grow');
    const key = repository.branchIssueKey;

    if (!repository.branch) {
      banner.classList.add('attention');
      grow.appendChild(node('span', null, 'Detached HEAD — check out a branch to link it to a ticket.'));
    } else if (key) {
      const issue = current.cards.filter(function (card) {
        return card.issue.key === key;
      })[0];
      grow.appendChild(node('span', 'muted', 'On '));
      grow.appendChild(node('span', 'branch', repository.branch));
      grow.appendChild(node('span', 'muted', ' → '));
      grow.appendChild(node('strong', null, key));
      if (issue) {
        grow.appendChild(node('span', null, ' · ' + issue.issue.status));
        grow.appendChild(node('span', 'muted', ' · ' + issue.issue.summary));
      }
      const open = node('button', 'ghost', 'Open ticket');
      open.type = 'button';
      open.addEventListener('click', function () {
        post('openIssue', { key: key });
      });
      banner.appendChild(grow);
      banner.appendChild(open);
      host.appendChild(banner);
      return;
    } else {
      banner.classList.add('attention');
      grow.appendChild(node('span', 'branch', repository.branch));
      grow.appendChild(
        node('span', 'muted', ' carries no issue key — pick a ticket below to start a branch for it.'),
      );
    }

    banner.appendChild(grow);
    host.appendChild(banner);
  }

  // ----------------------------------------------------------------- warnings

  function renderWarnings(current) {
    const host = clear(byId('warnings'));
    const counts = current.loadedStats.warnings;
    const active = current.filters.warning;
    let any = false;

    Object.keys(WARNING_LABELS).forEach(function (kind) {
      const count = counts[kind] || 0;
      // A warning nobody has is not news; keep an active filter visible so it
      // can always be switched off.
      if (count === 0 && active !== kind) return;
      any = true;
      const tile = node('button', 'warning-tile ' + WARNING_SEVERITY[kind]);
      tile.type = 'button';
      tile.title = WARNING_HINTS[kind] + ' Click to show only these.';
      tile.setAttribute('aria-pressed', String(active === kind));
      tile.appendChild(node('span', 'value', count));
      tile.appendChild(node('span', null, WARNING_LABELS[kind]));
      tile.addEventListener('click', function () {
        setFilters({ warning: active === kind ? undefined : kind });
      });
      host.appendChild(tile);
    });

    if (!any && current.loadedStats.total > 0) {
      const clean = node('div', 'warning-tile low');
      clean.appendChild(node('span', 'value', '✓'));
      clean.appendChild(node('span', null, 'Nothing needs attention'));
      host.appendChild(clean);
    }
  }

  // --------------------------------------------------------------- statistics

  function svg(tag, attributes) {
    const created = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attributes || {}).forEach(function (name) {
      created.setAttribute(name, String(attributes[name]));
    });
    return created;
  }

  /** A donut chart. Segments are drawn as dashed arcs on one circle path. */
  function donut(segments, centerValue, centerLabel) {
    const size = 108;
    const radius = 44;
    const circumference = 2 * Math.PI * radius;
    const total = segments.reduce(function (sum, segment) {
      return sum + segment.count;
    }, 0);
    const chart = svg('svg', {
      class: 'donut',
      width: size,
      height: size,
      viewBox: '0 0 ' + size + ' ' + size,
      role: 'img',
    });

    const track = svg('circle', {
      cx: size / 2,
      cy: size / 2,
      r: radius,
      fill: 'none',
      stroke: 'var(--vscode-panel-border)',
      'stroke-width': 12,
    });
    chart.appendChild(track);

    let offset = 0;
    segments.forEach(function (segment) {
      if (!segment.count) return;
      const length = (segment.count / total) * circumference;
      const arc = svg('circle', {
        cx: size / 2,
        cy: size / 2,
        r: radius,
        fill: 'none',
        stroke: segment.color,
        'stroke-width': 12,
        'stroke-linecap': 'butt',
        'stroke-dasharray': length + ' ' + (circumference - length),
        'stroke-dashoffset': -offset,
        transform: 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')',
      });
      const title = svg('title', {});
      title.textContent = segment.name + ': ' + segment.count;
      arc.appendChild(title);
      chart.appendChild(arc);
      offset += length;
    });

    const value = svg('text', {
      x: size / 2,
      y: size / 2 + 2,
      'text-anchor': 'middle',
      class: 'donut-center-value',
    });
    value.textContent = centerValue;
    chart.appendChild(value);

    const label = svg('text', {
      x: size / 2,
      y: size / 2 + 16,
      'text-anchor': 'middle',
      class: 'donut-center-label',
    });
    label.textContent = centerLabel;
    chart.appendChild(label);
    return chart;
  }

  function legend(segments) {
    const host = node('div', 'legend');
    segments.forEach(function (segment) {
      const row = node('div');
      const swatch = node('span', 'swatch');
      swatch.style.background = segment.color;
      row.appendChild(swatch);
      row.appendChild(node('span', 'name', segment.name));
      row.appendChild(node('span', 'count', segment.count));
      host.appendChild(row);
    });
    return host;
  }

  function barChart(rows, color) {
    const host = node('div', 'bars');
    const max = rows.reduce(function (highest, row) {
      return Math.max(highest, row.count);
    }, 0);
    rows.forEach(function (row) {
      const line = node('div', 'bar-row');
      const name = node('span', 'name', row.name);
      name.title = row.name;
      line.appendChild(name);
      const track = node('div', 'bar-track');
      const fill = node('span');
      fill.style.width = max > 0 ? Math.max(2, (row.count / max) * 100) + '%' : '0';
      if (row.color || color) fill.style.background = row.color || color;
      track.appendChild(fill);
      line.appendChild(track);
      line.appendChild(node('span', 'count', row.count));
      host.appendChild(line);
    });
    return host;
  }

  function kpi(label, value, hint, tone) {
    const card = node('div', 'panel kpi');
    card.appendChild(node('div', 'label', label));
    card.appendChild(node('div', 'value' + (tone ? ' ' + tone : ''), value));
    if (hint) card.appendChild(node('div', 'hint', hint));
    return card;
  }

  function renderStats(current) {
    const host = clear(byId('stats'));
    if (document.body.classList.contains('layout-sidebar')) return;
    if (current.loadedStats.total === 0) return;

    const stats = current.stats;
    const kpis = node('div', 'kpis');
    kpis.appendChild(kpi('Showing', stats.total, 'of ' + current.loadedStats.total + ' loaded'));
    kpis.appendChild(
      kpi('In progress', stats.byCategory.inprogress, 'active work', 'medium'),
    );
    kpis.appendChild(
      kpi(
        'Overdue',
        stats.warnings.overdue,
        stats.warnings.overdue > 0 ? 'needs a new date or a push' : 'nothing late',
        stats.warnings.overdue > 0 ? 'high' : 'good',
      ),
    );
    kpis.appendChild(
      kpi('Needs attention', stats.flagged, 'issues with a warning', stats.flagged > 0 ? 'medium' : 'good'),
    );
    host.appendChild(kpis);

    const grid = node('div', 'stats');

    const categorySegments = ['todo', 'inprogress', 'done'].map(function (category) {
      return {
        name: CATEGORY_LABELS[category],
        count: stats.byCategory[category],
        color: CATEGORY_COLOR[category],
      };
    });
    const progressPanel = node('div', 'panel');
    progressPanel.appendChild(node('h2', null, 'Progress'));
    const wrap = node('div', 'donut-wrap');
    wrap.appendChild(donut(categorySegments, stats.completion + '%', 'done'));
    wrap.appendChild(legend(categorySegments));
    progressPanel.appendChild(wrap);
    grid.appendChild(progressPanel);

    const duePanel = node('div', 'panel');
    duePanel.appendChild(node('h2', null, 'Deadlines'));
    duePanel.appendChild(
      barChart([
        { name: 'Overdue', count: stats.dueBuckets.overdue, color: 'var(--cb-high)' },
        { name: 'Today', count: stats.dueBuckets.today, color: 'var(--cb-medium)' },
        { name: 'Next 7 days', count: stats.dueBuckets.week, color: 'var(--cb-progress)' },
        { name: 'Later', count: stats.dueBuckets.later, color: 'var(--cb-todo)' },
        { name: 'No due date', count: stats.dueBuckets.none, color: 'var(--cb-low)' },
      ]),
    );
    grid.appendChild(duePanel);

    const peoplePanel = node('div', 'panel');
    peoplePanel.appendChild(node('h2', null, 'Workload'));
    peoplePanel.appendChild(
      barChart(stats.byAssignee.slice(0, 6), 'var(--vscode-charts-purple, #b180d7)'),
    );
    grid.appendChild(peoplePanel);

    const statusPanel = node('div', 'panel');
    statusPanel.appendChild(node('h2', null, 'By status'));
    statusPanel.appendChild(barChart(stats.byStatus.slice(0, 6), 'var(--cb-todo)'));
    grid.appendChild(statusPanel);

    host.appendChild(grid);
  }

  // -------------------------------------------------------------------- board

  function branchButton(card) {
    const branches = card.branches || [];
    if (card.onBranch) {
      const current = node('button', 'ghost', '✓ On this branch');
      current.type = 'button';
      current.disabled = true;
      return current;
    }
    const label = branches.length > 0 ? 'Switch branch' : 'Create branch';
    const button = node('button', branches.length > 0 ? '' : 'ghost', label);
    button.type = 'button';
    button.title =
      branches.length > 0
        ? 'Check out ' + branches[0].name
        : 'Create a branch for ' + card.issue.key + ' from the current HEAD';
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      post('checkout', { key: card.issue.key });
    });
    return button;
  }

  function issueCard(card, current) {
    const issue = card.issue;
    const severity = (card.warnings[0] && card.warnings[0].severity) || '';
    const element = node('article', 'issue' + (severity ? ' sev-' + severity : ''));
    if (card.onBranch) element.classList.add('on-branch');
    element.tabIndex = 0;
    element.dataset.key = issue.key;
    element.setAttribute('role', 'button');
    element.title = issue.key + ' — ' + issue.summary;

    const top = node('div', 'issue-top');
    top.appendChild(node('span', 'key', issue.key));
    top.appendChild(node('span', 'tag', issue.type));
    const priority = priorityTag(issue.priority);
    if (priority) top.appendChild(priority);
    const due = dueTag(issue, current.now);
    if (due) top.appendChild(due);
    element.appendChild(top);

    element.appendChild(node('div', 'summary', issue.summary));

    const meta = node('div', 'issue-meta');
    const avatar = node('span', 'avatar', initials(issue.assignee || '?'));
    avatar.title = issue.assignee ? 'Assigned to ' + issue.assignee : 'Unassigned';
    meta.appendChild(avatar);
    meta.appendChild(node('span', 'who', issue.assignee || 'Unassigned'));
    meta.appendChild(node('span', 'tag', issue.status));
    if (card.branches.length > 0) {
      const branch = node('span', 'tag branch', card.branches[0].localName);
      branch.title =
        card.branches.length === 1
          ? 'Branch ' + card.branches[0].name
          : card.branches.length + ' branches carry this key';
      meta.appendChild(branch);
    }
    element.appendChild(meta);

    if (card.warnings.length > 0) {
      const warns = node('div', 'warns');
      card.warnings.forEach(function (warning) {
        warns.appendChild(node('div', warning.severity, warning.label));
      });
      element.appendChild(warns);
    }

    const actions = node('div', 'issue-actions');
    actions.appendChild(branchButton(card));

    const open = node('button', 'ghost', 'Jira');
    open.type = 'button';
    open.title = 'Open ' + issue.key + ' in the browser';
    open.addEventListener('click', function (event) {
      event.stopPropagation();
      post('openIssue', { key: issue.key });
    });
    actions.appendChild(open);

    const ask = node('button', 'ghost', 'Ask CodeBrain');
    ask.type = 'button';
    ask.title = 'Open Chat with this ticket as the question';
    ask.addEventListener('click', function (event) {
      event.stopPropagation();
      post('ask', { key: issue.key });
    });
    actions.appendChild(ask);

    if (current.config.allowWrite) {
      const move = node('button', 'ghost', 'Move');
      move.type = 'button';
      move.title = 'Transition this issue to another status';
      move.addEventListener('click', function (event) {
        event.stopPropagation();
        post('transition', { key: issue.key });
      });
      actions.appendChild(move);
    }

    const copy = node('button', 'ghost', 'Copy key');
    copy.type = 'button';
    copy.addEventListener('click', function (event) {
      event.stopPropagation();
      post('copyKey', { key: issue.key });
    });
    actions.appendChild(copy);

    element.appendChild(actions);

    // The card itself opens the ticket; keyboard users get the same on Enter.
    element.addEventListener('click', function () {
      post('openIssue', { key: issue.key });
    });
    element.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        post('openIssue', { key: issue.key });
      }
    });
    return element;
  }

  function emptyState(title, body, actions) {
    const state = node('div', 'state');
    state.appendChild(node('strong', null, title));
    state.appendChild(node('span', null, body));
    if (actions && actions.length > 0) {
      const row = node('div', 'actions');
      actions.forEach(function (action) {
        const button = node('button', action.ghost ? 'ghost' : '', action.label);
        button.type = 'button';
        button.addEventListener('click', action.run);
        row.appendChild(button);
      });
      state.appendChild(row);
    }
    return state;
  }

  function renderBoard(current) {
    const host = clear(byId('board'));

    // Loading is checked before anything else: on the very first load the
    // credentials have not been resolved yet, and flashing "connect Jira" at
    // someone who has already connected it reads as a broken setup.
    if (current.data.loading && current.data.issues.length === 0) {
      host.appendChild(emptyState('Loading your board…', 'Asking Jira for the issues in this filter.', []));
      return;
    }

    if (!current.data.configured) {
      host.appendChild(
        emptyState(
          'Connect Jira to see your board',
          'CodeBrain needs a Jira base URL and a personal access token. The same credentials power ticket lookups for every agent.',
          [{ label: 'Configure Atlassian…', run: function () { post('configure'); } }],
        ),
      );
      return;
    }

    if (current.data.issues.length === 0 && current.data.error) {
      host.appendChild(
        emptyState(
          'The board could not be loaded',
          'Jira answered with an error, shown above. Check the connection, then try again.',
          [
            { label: 'Try again', run: function () { post('refresh'); } },
            { label: 'Test connection…', ghost: true, run: function () { post('testConnection'); } },
          ],
        ),
      );
      return;
    }

    if (current.data.issues.length === 0) {
      host.appendChild(
        emptyState(
          'No issues matched the query',
          'Nothing came back for “' + current.summary + '”. Widen the scope, or clear the project filter.',
          [
            { label: 'Show everyone', run: function () { setFilters({ scope: 'all' }); } },
            { label: 'Reset filters', ghost: true, run: function () { post('resetFilters'); } },
          ],
        ),
      );
      return;
    }

    if (current.cards.length === 0) {
      host.appendChild(
        emptyState(
          'Every loaded issue is filtered out',
          current.loadedStats.total + ' issue(s) are loaded, but none match the filters on screen.',
          [{ label: 'Reset filters', run: function () { post('resetFilters'); } }],
        ),
      );
      return;
    }

    const columns = node('div', 'columns');
    current.filters.categories.forEach(function (category) {
      const cards = current.cards.filter(function (card) {
        return card.issue.category === category;
      });
      const column = node('div', 'column');
      const head = node('div', 'column-head');
      const dot = node('span', 'dot');
      dot.style.background = CATEGORY_COLOR[category];
      head.appendChild(dot);
      head.appendChild(node('span', null, CATEGORY_LABELS[category]));
      head.appendChild(node('span', 'count', cards.length));
      column.appendChild(head);

      const body = node('div', 'column-body');
      if (cards.length === 0) {
        body.appendChild(node('div', 'muted', 'Nothing here.'));
      } else {
        cards.forEach(function (card) {
          body.appendChild(issueCard(card, current));
        });
      }
      column.appendChild(body);
      columns.appendChild(column);
    });
    host.appendChild(columns);
  }

  // ------------------------------------------------------------------- footer

  function renderFooter(current) {
    const host = clear(byId('footer'));
    if (!current.data.configured) return;

    const parts = [];
    parts.push(current.cards.length + ' shown · ' + current.loadedStats.total + ' loaded');
    if (current.data.capped && current.data.total) {
      parts.push('Jira has ' + current.data.total + ' matching — raise codebrain.jira.maxIssues to load more');
    }
    if (current.data.loadedAt) parts.push('updated ' + relativeTime(new Date(current.data.loadedAt).toISOString()));
    if (current.data.me) parts.push('as ' + current.data.me);
    host.appendChild(node('span', null, parts.join(' · ')));

    if (current.data.jql) {
      const jql = node('code', 'muted', current.data.jql);
      jql.title = 'The JQL this board is running. Override it with codebrain.jira.jql.';
      host.appendChild(jql);
    }
  }

  // ------------------------------------------------------------------- render

  function render(next) {
    view = next;
    byId('loading').classList.toggle('hidden', !next.data.loading);

    const error = byId('error');
    if (next.data.error) {
      clear(error);
      error.appendChild(node('strong', null, 'Jira could not be reached. '));
      error.appendChild(node('span', null, next.data.error));
      error.classList.remove('hidden');
    } else {
      error.classList.add('hidden');
    }

    const subtitle = byId('subtitle');
    if (subtitle) subtitle.textContent = next.summary;

    syncToolbar(next);
    renderBanner(next);
    renderWarnings(next);
    renderStats(next);
    renderBoard(next);
    renderFooter(next);
  }

  // -------------------------------------------------------------- interaction

  document.querySelectorAll('[data-scope]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      setFilters({ scope: chip.dataset.scope });
    });
  });

  document.querySelectorAll('[data-category]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      if (!view) return;
      const next = view.filters.categories.slice();
      const at = next.indexOf(chip.dataset.category);
      if (at >= 0) next.splice(at, 1);
      else next.push(chip.dataset.category);
      // Keep the board's own order, not click order, so the columns never swap.
      const ordered = ['todo', 'inprogress', 'done'].filter(function (category) {
        return next.indexOf(category) >= 0;
      });
      setFilters({ categories: ordered });
    });
  });

  byId('due').addEventListener('change', function (event) {
    setFilters({ due: event.target.value });
  });
  byId('sort').addEventListener('change', function (event) {
    setFilters({ sort: event.target.value });
  });
  byId('sprint').addEventListener('change', function (event) {
    setFilters({ openSprintsOnly: event.target.checked });
  });
  byId('projects').addEventListener('change', function (event) {
    setFilters({ projects: event.target.value });
  });

  // Debounced: every keystroke re-filters in the extension, but a round-trip
  // per character would make typing feel heavy.
  byId('search').addEventListener('input', function (event) {
    const value = event.target.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      setFilters({ text: value });
    }, 180);
  });

  byId('refresh').addEventListener('click', function () {
    post('refresh');
  });
  byId('reset').addEventListener('click', function () {
    post('resetFilters');
  });
  const openBoard = byId('openBoard');
  if (openBoard) openBoard.addEventListener('click', function () { post('openBoard'); });
  const fetchButton = byId('fetch');
  if (fetchButton) fetchButton.addEventListener('click', function () { post('fetch'); });

  window.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'state') render(event.data.view);
  });

  // The extension answers with the current state; a reloaded webview therefore
  // never has to keep its own copy of the board.
  post('ready');
})();
