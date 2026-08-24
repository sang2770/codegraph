/**
 * The read-only MCP tool surface over Jira and Confluence (Collab).
 *
 * Two rules shape everything in this file, both learned from how coding agents
 * actually behave:
 *
 *  1. **Errors teach abandonment.** An `isError` reply early in a session and
 *     the agent stops calling the server for the rest of it. So every
 *     *expected* condition — product not configured, no results, a malformed
 *     argument — comes back as a normal success reply that carries the
 *     guidance. `isError` is reserved for a genuine malfunction.
 *  2. **Sufficiency stops the reading.** A reply that answers half the question
 *     sends the agent off to a browser or to guessing. Search results therefore
 *     carry the fields needed to decide what to open next (status, assignee,
 *     last update, direct URL), and the detail tools return the full body in
 *     one call.
 */

import {
  AtlassianClient,
  ConfluenceContent,
  isAtlassianRequestError,
  JiraComment,
  JiraIssue,
} from './client';
import { AtlassianConnections } from './connection';
import {
  DEFAULT_MAX_BODY_CHARACTERS,
  formatTimestamp,
  quoteQueryLiteral,
  renderJiraText,
  storageToText,
  truncate,
} from './format';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolContext {
  client: AtlassianClient;
  connections: AtlassianConnections;
  /** Shown in guidance text so the user knows which file to fix. */
  envFile: string;
  defaultLimit?: number;
  maxBodyCharacters?: number;
}

export const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

/** Everything this server can ever do. Filtered per configured product. */
const ALL_TOOLS: readonly (ToolDefinition & { product: 'jira' | 'confluence' })[] = [
  {
    product: 'confluence',
    name: 'confluence_search',
    description:
      'Search Confluence (Collab) pages and blog posts by free text. Returns title, space, last update, direct URL and a matching excerpt for each hit — enough to pick which page to open with confluence_get_page. Pass spaceKey to scope the search to one space, or cql for a full Confluence Query Language expression when free text is not precise enough.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Free-text search terms, for example "OTA update rollback procedure".',
        },
        spaceKey: {
          type: 'string',
          description: 'Restrict to one space key, for example "PLATFORM".',
        },
        cql: {
          type: 'string',
          description:
            'Raw CQL, used verbatim instead of query/spaceKey. Example: text ~ "rollback" AND space = "PLATFORM" AND lastmodified > now("-30d").',
        },
        limit: {
          type: 'number',
          description: `Maximum results, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT}).`,
        },
      },
    },
  },
  {
    product: 'confluence',
    name: 'confluence_get_page',
    description:
      'Read one Confluence (Collab) page in full: metadata plus the whole body as plain text. Identify the page by pageId (from confluence_search), or by exact title plus spaceKey. Treat the returned body as already read — do not open the page in a browser to re-read it.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: {
          type: 'string',
          description: 'Numeric Confluence content id, for example "123456789".',
        },
        title: {
          type: 'string',
          description: 'Exact page title. Use together with spaceKey.',
        },
        spaceKey: {
          type: 'string',
          description: 'Space key that contains the titled page.',
        },
      },
    },
  },
  {
    product: 'jira',
    name: 'jira_search',
    description:
      'Search Jira issues. Pass jql for a precise query, or query for free text (matched across summary, description and comments). Each hit carries key, summary, status, type, priority, assignee, last update and a direct URL — enough to decide which issue to open with jira_get_issue.',
    inputSchema: {
      type: 'object',
      properties: {
        jql: {
          type: 'string',
          description:
            'JQL, used verbatim. Example: project = ABC AND status != Done AND updated >= -14d ORDER BY updated DESC.',
        },
        query: {
          type: 'string',
          description: 'Free-text search terms, used when jql is not supplied.',
        },
        projectKey: {
          type: 'string',
          description: 'Restrict a free-text search to one project key.',
        },
        limit: {
          type: 'number',
          description: `Maximum results, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT}).`,
        },
      },
    },
  },
  {
    product: 'jira',
    name: 'jira_get_issue',
    description:
      'Read one Jira issue in full: all common fields, the complete description, linked issues and subtasks, and optionally the comment thread. Treat the result as already read.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Issue key, for example "ABC-1234".',
        },
        includeComments: {
          type: 'boolean',
          description:
            'Append the comment thread (default true) — comments usually hold the reproduction steps and the decision.',
        },
        commentLimit: {
          type: 'number',
          description: `Maximum comments when includeComments is true, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT}).`,
        },
      },
      required: ['key'],
    },
  },
  {
    product: 'jira',
    name: 'jira_get_comments',
    description:
      'Read the comment thread of one Jira issue, newest first. Use when the issue body is already known and only the discussion is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Issue key, for example "ABC-1234".' },
        limit: {
          type: 'number',
          description: `Maximum comments, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT}).`,
        },
      },
      required: ['key'],
    },
  },
];

/**
 * Tools for the products that are actually configured.
 *
 * A tool for an unconfigured product would be picked, fail, and cost the
 * server the agent's trust — so Jira-only setups never see Confluence tools.
 * When nothing is configured we still list everything, because the reply that
 * explains how to configure it is more useful than an empty tool list.
 */
export function listTools(connections: AtlassianConnections): ToolDefinition[] {
  const configured = Boolean(connections.jira || connections.confluence);
  return ALL_TOOLS.filter((tool) => {
    if (!configured) return true;
    return tool.product === 'jira' ? Boolean(connections.jira) : Boolean(connections.confluence);
  }).map(({ product: _product, ...tool }) => tool);
}

export function toolNames(connections: AtlassianConnections): string[] {
  return listTools(connections).map((tool) => tool.name);
}

/** Raised for a bad argument. Reported as guidance, never as `isError`. */
class InvalidArgument extends Error {}

export async function callTool(
  name: string,
  rawArguments: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  const args = (rawArguments ?? {}) as Record<string, unknown>;
  const product = ALL_TOOLS.find((tool) => tool.name === name)?.product;

  if (!product) {
    return guidance(
      `Unknown tool "${name}". Available tools: ${toolNames(context.connections).join(', ') || 'none'}.`,
    );
  }
  if (product === 'jira' && !context.client.hasJira) {
    return guidance(notConfiguredMessage('Jira', context.envFile));
  }
  if (product === 'confluence' && !context.client.hasConfluence) {
    return guidance(notConfiguredMessage('Confluence (Collab)', context.envFile));
  }

  try {
    switch (name) {
      case 'confluence_search':
        return await confluenceSearch(args, context);
      case 'confluence_get_page':
        return await confluenceGetPage(args, context);
      case 'jira_search':
        return await jiraSearch(args, context);
      case 'jira_get_issue':
        return await jiraGetIssue(args, context);
      case 'jira_get_comments':
        return await jiraGetComments(args, context);
      default:
        return guidance(`Tool "${name}" is not implemented.`);
    }
  } catch (error) {
    if (error instanceof InvalidArgument) return guidance(error.message);
    if (isAtlassianRequestError(error)) {
      // A rejected token, a missing page, a permission gap: all recoverable by
      // the caller, so they read as guidance rather than a server failure.
      return guidance(`Atlassian request failed: ${error.message}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: `The CodeBrain Atlassian server hit an unexpected failure: ${message}. Retry once; if it persists, report it with this message.`,
        },
      ],
      isError: true,
    };
  }
}

// ------------------------------------------------------------------ handlers

async function confluenceSearch(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const limit = readLimit(args.limit, context.defaultLimit);
  const cql = buildConfluenceCql(args);
  const response = await context.client.confluenceSearch({ cql, limit });
  const results = response.results ?? [];

  if (results.length === 0) {
    return guidance(
      [
        `No Confluence results for CQL: ${cql}`,
        '',
        'Next steps: drop the spaceKey filter, use fewer or more common terms, or search Jira instead — the decision may live on an issue rather than a page.',
      ].join('\n'),
    );
  }

  const total = response.totalSize ?? response.size ?? results.length;
  const base = context.client.confluenceBaseUrl ?? '';
  const lines = [
    `# Confluence results (${results.length} shown of ${total})`,
    `CQL: ${cql}`,
    '',
  ];

  for (const page of results) {
    lines.push(...describeConfluenceHeader(page, base));
    const excerpt = page.excerpt ? storageToText(page.excerpt) : '';
    if (excerpt) lines.push('', truncate(excerpt, 500));
    lines.push('');
  }

  lines.push(
    'Open the most relevant page with confluence_get_page (pageId above) to get its full text.',
  );
  return text(lines.join('\n'));
}

async function confluenceGetPage(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const pageId = optionalString(args.pageId, 'pageId');
  const title = optionalString(args.title, 'title');
  const spaceKey = optionalString(args.spaceKey, 'spaceKey');

  if (!pageId && !title) {
    throw new InvalidArgument(
      'confluence_get_page needs either pageId, or title (with spaceKey when the title is not unique). Run confluence_search first to get a pageId.',
    );
  }

  let page: ConfluenceContent | undefined;
  if (pageId) {
    if (!/^\d+$/.test(pageId)) {
      throw new InvalidArgument(
        `pageId must be the numeric Confluence content id, got "${pageId}". Use confluence_search to find it, or pass title + spaceKey instead.`,
      );
    }
    page = await context.client.confluencePage(pageId);
  } else {
    const matches = await context.client.confluencePageByTitle(title!, spaceKey);
    const results = matches.results ?? [];
    if (results.length === 0) {
      return guidance(
        `No Confluence page titled "${title}"${spaceKey ? ` in space ${spaceKey}` : ''}. Titles must match exactly — use confluence_search for a fuzzy lookup.`,
      );
    }
    if (results.length > 1 && !spaceKey) {
      const base = context.client.confluenceBaseUrl ?? '';
      const lines = [
        `"${title}" matches ${results.length} pages. Pass spaceKey, or call confluence_get_page again with one of these ids:`,
        '',
      ];
      for (const match of results) lines.push(...describeConfluenceHeader(match, base));
      return guidance(lines.join('\n'));
    }
    page = results[0];
  }

  const base = context.client.confluenceBaseUrl ?? '';
  const body = storageToText(page?.body?.storage?.value ?? '');
  const lines = [
    `# ${page?.title ?? '(untitled)'}`,
    ...describeConfluenceMetadata(page, base),
    '',
    '---',
    '',
    body
      ? truncate(body, context.maxBodyCharacters ?? DEFAULT_MAX_BODY_CHARACTERS)
      : '(This page has no text body — it may be a container page, or hold only attachments and macros.)',
  ];
  return text(lines.join('\n'));
}

async function jiraSearch(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const limit = readLimit(args.limit, context.defaultLimit);
  const jql = buildJiraJql(args);
  const response = await context.client.jiraSearch({ jql, limit });
  const issues = response.issues ?? [];

  if (issues.length === 0) {
    return guidance(
      [
        `No Jira issues for JQL: ${jql}`,
        '',
        'Next steps: widen the date range, drop the project filter, or check the project key — a wrong key returns nothing rather than an error.',
      ].join('\n'),
    );
  }

  const base = context.client.jiraBaseUrl ?? '';
  const lines = [
    `# Jira results (${issues.length} shown of ${response.total ?? issues.length})`,
    `JQL: ${jql}`,
    '',
  ];

  for (const issue of issues) {
    lines.push(`## ${issue.key} — ${fieldString(issue.fields?.summary) || '(no summary)'}`);
    lines.push(summaryLine(issue));
    lines.push(`URL: ${base}/browse/${issue.key}`);
    lines.push('');
  }

  lines.push('Open the most relevant issue with jira_get_issue to get its description and comments.');
  return text(lines.join('\n'));
}

async function jiraGetIssue(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const key = readIssueKey(args.key);
  const includeComments = args.includeComments === undefined ? true : Boolean(args.includeComments);
  const commentLimit = readLimit(args.commentLimit, context.defaultLimit);

  const issue = await context.client.jiraIssue(key);
  const base = context.client.jiraBaseUrl ?? '';
  const fields = issue.fields ?? {};

  const lines = [
    `# ${issue.key} — ${fieldString(fields.summary) || '(no summary)'}`,
    summaryLine(issue),
    `URL: ${base}/browse/${issue.key}`,
  ];

  const parent = fields.parent as JiraIssue | undefined;
  if (parent?.key) {
    lines.push(`Parent: ${parent.key} — ${fieldString(parent.fields?.summary)}`);
  }

  const labels = Array.isArray(fields.labels) ? fields.labels.map(String) : [];
  if (labels.length > 0) lines.push(`Labels: ${labels.join(', ')}`);

  const components = namedList(fields.components);
  if (components) lines.push(`Components: ${components}`);

  const fixVersions = namedList(fields.fixVersions);
  if (fixVersions) lines.push(`Fix versions: ${fixVersions}`);

  const resolution = fieldString((fields.resolution as { name?: string } | undefined)?.name);
  if (resolution) lines.push(`Resolution: ${resolution}`);

  const dueDate = fieldString(fields.duedate);
  if (dueDate) lines.push(`Due: ${dueDate}`);

  const subtasks = Array.isArray(fields.subtasks) ? (fields.subtasks as JiraIssue[]) : [];
  if (subtasks.length > 0) {
    lines.push('', '## Subtasks');
    for (const subtask of subtasks) {
      lines.push(
        `- ${subtask.key} — ${fieldString(subtask.fields?.summary)} [${fieldString((subtask.fields?.status as { name?: string } | undefined)?.name)}]`,
      );
    }
  }

  const links = describeIssueLinks(fields.issuelinks);
  if (links.length > 0) lines.push('', '## Linked issues', ...links);

  const description = renderJiraText(fields.description);
  lines.push('', '## Description', '');
  lines.push(
    description
      ? truncate(description, context.maxBodyCharacters ?? DEFAULT_MAX_BODY_CHARACTERS)
      : '(empty)',
  );

  if (includeComments) {
    try {
      const comments = await context.client.jiraComments(key, commentLimit);
      lines.push('', ...formatComments(comments.comments ?? [], comments.total, context));
    } catch (error) {
      // The issue body is the valuable part; a comment-permission gap must not
      // throw it away.
      const message = error instanceof Error ? error.message : String(error);
      lines.push('', `## Comments`, '', `(Could not load comments: ${message})`);
    }
  }

  return text(lines.join('\n'));
}

async function jiraGetComments(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const key = readIssueKey(args.key);
  const limit = readLimit(args.limit, context.defaultLimit);
  const response = await context.client.jiraComments(key, limit);
  const comments = response.comments ?? [];

  if (comments.length === 0) {
    return guidance(`${key} has no comments. Use jira_get_issue for its description and fields.`);
  }

  return text([`# Comments on ${key}`, '', ...formatComments(comments, response.total, context)].join('\n'));
}

// ------------------------------------------------------- query construction

/**
 * Build the CQL for a search. Free text goes through `text ~ "…"` with the
 * literal escaped, so a query containing a quote cannot change the clause.
 */
export function buildConfluenceCql(args: Record<string, unknown>): string {
  const raw = optionalString(args.cql, 'cql');
  if (raw) return raw;

  const query = optionalString(args.query, 'query');
  if (!query) {
    throw new InvalidArgument(
      'confluence_search needs query (free text) or cql (a Confluence Query Language expression).',
    );
  }

  const clauses = [`text ~ ${quoteQueryLiteral(query)}`];
  const spaceKey = optionalString(args.spaceKey, 'spaceKey');
  if (spaceKey) clauses.push(`space = ${quoteQueryLiteral(spaceKey)}`);
  clauses.push('type in (page, blogpost)');

  return `${clauses.join(' AND ')} ORDER BY lastmodified DESC`;
}

/** Build the JQL for a search, mirroring {@link buildConfluenceCql}. */
export function buildJiraJql(args: Record<string, unknown>): string {
  const raw = optionalString(args.jql, 'jql');
  if (raw) return raw;

  const query = optionalString(args.query, 'query');
  if (!query) {
    throw new InvalidArgument(
      'jira_search needs jql (a JQL expression) or query (free text).',
    );
  }

  const clauses = [`text ~ ${quoteQueryLiteral(query)}`];
  const projectKey = optionalString(args.projectKey, 'projectKey');
  if (projectKey) clauses.unshift(`project = ${quoteQueryLiteral(projectKey)}`);

  return `${clauses.join(' AND ')} ORDER BY updated DESC`;
}

// ------------------------------------------------------------- formatting

function describeConfluenceHeader(page: ConfluenceContent, base: string): string[] {
  const lines = [`## ${page.title ?? '(untitled)'}`];
  lines.push(...describeConfluenceMetadata(page, base));
  return lines;
}

function describeConfluenceMetadata(
  page: ConfluenceContent | undefined,
  base: string,
): string[] {
  if (!page) return [];
  const parts: string[] = [];
  const space = page.space?.name ?? page.space?.key;
  if (space) parts.push(`space ${space}${page.space?.key ? ` (${page.space.key})` : ''}`);
  if (page.type) parts.push(page.type);
  if (page.version?.number !== undefined) parts.push(`v${page.version.number}`);

  const updatedWhen = page.version?.when ?? page.history?.lastUpdated?.when;
  const updatedBy =
    page.version?.by?.displayName ?? page.history?.lastUpdated?.by?.displayName;
  const timestamp = formatTimestamp(updatedWhen);
  if (timestamp) parts.push(`updated ${timestamp}${updatedBy ? ` by ${updatedBy}` : ''}`);

  const lines: string[] = [];
  if (page.id) lines.push(`pageId: ${page.id}`);
  if (parts.length > 0) lines.push(parts.join(' · '));
  const webui = page._links?.webui;
  if (webui) lines.push(`URL: ${base}${webui.startsWith('/') ? '' : '/'}${webui}`);
  return lines;
}

function summaryLine(issue: JiraIssue): string {
  const fields = issue.fields ?? {};
  const parts = [
    fieldString((fields.status as { name?: string } | undefined)?.name) || 'unknown status',
    fieldString((fields.issuetype as { name?: string } | undefined)?.name),
    fieldString((fields.priority as { name?: string } | undefined)?.name),
  ].filter(Boolean);

  const assignee = fieldString(
    (fields.assignee as { displayName?: string; name?: string } | undefined)?.displayName ??
      (fields.assignee as { name?: string } | undefined)?.name,
  );
  parts.push(assignee ? `assignee ${assignee}` : 'unassigned');

  const updated = formatTimestamp(fields.updated);
  if (updated) parts.push(`updated ${updated}`);

  return parts.join(' · ');
}

function describeIssueLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  for (const entry of value as {
    type?: { inward?: string; outward?: string };
    inwardIssue?: JiraIssue;
    outwardIssue?: JiraIssue;
  }[]) {
    const linked = entry.outwardIssue ?? entry.inwardIssue;
    if (!linked?.key) continue;
    const relation = entry.outwardIssue ? entry.type?.outward : entry.type?.inward;
    lines.push(
      `- ${relation ?? 'relates to'}: ${linked.key} — ${fieldString(linked.fields?.summary)}`,
    );
  }
  return lines;
}

function formatComments(
  comments: readonly JiraComment[],
  total: number | undefined,
  context: ToolContext,
): string[] {
  const lines = [`## Comments (${comments.length} shown of ${total ?? comments.length})`];
  // Per-comment budget: one long comment must not crowd out the rest.
  const perComment = Math.max(
    500,
    Math.floor((context.maxBodyCharacters ?? DEFAULT_MAX_BODY_CHARACTERS) / Math.max(1, comments.length)),
  );

  for (const comment of comments) {
    const author = comment.author?.displayName ?? 'unknown';
    const when = formatTimestamp(comment.created);
    lines.push('', `### ${author}${when ? ` · ${when}` : ''}`);
    const body = renderJiraText(comment.body);
    lines.push(body ? truncate(body, perComment) : '(empty comment)');
  }
  return lines;
}

// ------------------------------------------------------- argument plumbing

function readLimit(value: unknown, fallback = DEFAULT_LIMIT): number {
  const requested = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isFinite(requested)) {
    throw new InvalidArgument(`limit must be a number between 1 and ${MAX_LIMIT}.`);
  }
  // Clamp rather than reject: an over-large limit is a reasonable intent, and
  // failing the call over it wastes a round-trip.
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(requested)));
}

function readIssueKey(value: unknown): string {
  const key = optionalString(value, 'key');
  if (!key) throw new InvalidArgument('key is required, for example "ABC-1234".');
  const normalized = key.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(normalized)) {
    throw new InvalidArgument(
      `"${key}" is not a Jira issue key. Expected PROJECT-NUMBER, for example "ABC-1234". Use jira_search to find the key from free text.`,
    );
  }
  return normalized;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new InvalidArgument(`${name} must be a string, got ${typeof value}.`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function fieldString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function namedList(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) => fieldString((entry as { name?: string } | undefined)?.name))
    .filter(Boolean)
    .join(', ');
}

function text(body: string): ToolResult {
  return { content: [{ type: 'text', text: body }] };
}

/**
 * A success-shaped reply that carries guidance. Not an error: see rule 1 at the
 * top of this file.
 */
function guidance(body: string): ToolResult {
  return text(body);
}

export function notConfiguredMessage(product: string, envFile: string): string {
  return [
    `${product} is not configured for CodeBrain, so this tool has nothing to query.`,
    '',
    'To enable it, the user runs "CodeBrain: Configure Atlassian (Collab + Jira)" from the VS Code command palette,',
    `or sets the credentials in ${envFile}.`,
    '',
    'Continue with the tools that are available — do not retry this one in this session.',
  ].join('\n');
}
