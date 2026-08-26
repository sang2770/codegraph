/**
 * The MCP tool surface over Jira and Confluence (Collab).
 *
 * Three rules shape everything in this file, all learned from how coding agents
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
 *  3. **Writing is opt-in and invisible until it is.** The tools that change a
 *     real ticket or a real page are gated behind
 *     `CODEBRAIN_ATLASSIAN_ALLOW_WRITE`. While it is off they are not listed at
 *     all — an agent cannot pick a tool it never saw — and calling one by name
 *     anyway answers with how to turn it on rather than with a failure. Every
 *     write reports back what it actually changed (new status, new version,
 *     direct URL) so the agent never has to guess whether the call landed.
 */

import {
  AtlassianClient,
  ConfluenceAttachment,
  ConfluenceContent,
  isAtlassianRequestError,
  JiraAttachment,
  JiraComment,
  JiraIssue,
  JiraTransition,
  JiraUser,
} from './client';
import { AtlassianConnections } from './connection';
import {
  DEFAULT_MAX_BODY_CHARACTERS,
  formatBytes,
  formatTimestamp,
  quoteQueryLiteral,
  renderJiraText,
  storageToText,
  textToStorage,
  truncate,
} from './format';

/** An MCP content block. Images are returned inline, base64-encoded. */
export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
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
  /** Largest single image returned inline. Bigger ones are named but skipped. */
  maxImageBytes?: number;
  /** Whether the mutating tools are reachable at all. Off unless opted in. */
  allowWrite?: boolean;
}

export const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

/** Default per-image ceiling; a screenshot is well under it, a video is not. */
export const DEFAULT_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Ceiling across one reply, so a page of screenshots cannot flood the context. */
const MAX_IMAGE_BYTES_PER_REPLY = 16 * 1024 * 1024;
/** Images returned by one call when the caller does not say. */
const DEFAULT_IMAGE_LIMIT = 5;

/**
 * Everything this server can ever do. Filtered per configured product, and —
 * for the `write` entries — per {@link ToolContext.allowWrite}.
 */
const ALL_TOOLS: readonly (ToolDefinition & {
  product: 'jira' | 'confluence';
  write?: true;
})[] = [
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
    product: 'confluence',
    name: 'confluence_get_page_images',
    description:
      'Return the images attached to a Confluence (Collab) page as inline images you can actually look at — diagrams, screenshots, mockups. Use it whenever the page text references a figure, or when the answer is in a diagram rather than in prose. Non-image attachments are listed by name but not returned.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: {
          type: 'string',
          description: 'Numeric Confluence content id, from confluence_search or confluence_get_page.',
        },
        filename: {
          type: 'string',
          description:
            'Return only the attachment with this exact filename, when the page holds many images and the body named the one you want.',
        },
        limit: {
          type: 'number',
          description: `Maximum images, 1-${MAX_LIMIT} (default ${DEFAULT_IMAGE_LIMIT}).`,
        },
      },
      required: ['pageId'],
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
  {
    product: 'jira',
    name: 'jira_get_issue_images',
    description:
      'Return the images attached to a Jira issue as inline images you can actually look at — screenshots of the bug, a stack-trace capture, a design mockup. Use it whenever an issue mentions a screenshot or the description alone does not show the failure. Non-image attachments (logs, zips) are listed by name but not returned.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Issue key, for example "ABC-1234".' },
        filename: {
          type: 'string',
          description:
            'Return only the attachment with this exact filename, when the issue holds many images and a comment named the one you want.',
        },
        limit: {
          type: 'number',
          description: `Maximum images, 1-${MAX_LIMIT} (default ${DEFAULT_IMAGE_LIMIT}).`,
        },
      },
      required: ['key'],
    },
  },

  // ------------------------------------------------------------------ writes
  //
  // Listed only when write access is enabled. jira_get_transitions is a read,
  // but it exists purely to serve jira_transition_issue, so it appears and
  // disappears with it rather than adding noise to a read-only session.

  {
    product: 'jira',
    write: true,
    name: 'jira_add_comment',
    description:
      'Post a comment on a Jira issue. Use it to record what was found, what was changed, or which commit fixes the issue — the comment thread is where the team looks. Write plain text; formatting is applied for the target Jira automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Issue key, for example "ABC-1234".' },
        body: {
          type: 'string',
          description:
            'Comment text. Blank lines separate paragraphs. Say what changed and why — a comment that only says "done" costs the next reader a full investigation.',
        },
      },
      required: ['key', 'body'],
    },
  },
  {
    product: 'jira',
    write: true,
    name: 'jira_get_transitions',
    description:
      'List the workflow transitions available from a Jira issue\'s current status, with the status each one leads to. Call this before jira_transition_issue when unsure what the workflow allows — transition names are per-project and rarely the obvious ones.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Issue key, for example "ABC-1234".' },
      },
      required: ['key'],
    },
  },
  {
    product: 'jira',
    write: true,
    name: 'jira_transition_issue',
    description:
      'Move a Jira issue through its workflow, for example to "In Progress" or "Done". Name the transition or the target status — it is matched against what the workflow actually offers, and an unavailable one answers with the list of valid choices instead of failing. The reply confirms the status the issue ended up in.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Issue key, for example "ABC-1234".' },
        transition: {
          type: 'string',
          description:
            'Transition name or target status, for example "Start Progress" or "In Progress". Matched case-insensitively.',
        },
        transitionId: {
          type: 'string',
          description: 'Numeric transition id from jira_get_transitions, when the name is ambiguous.',
        },
        comment: {
          type: 'string',
          description: 'Optional comment posted as part of the same transition.',
        },
      },
      required: ['key'],
    },
  },
  {
    product: 'jira',
    write: true,
    name: 'jira_assign_issue',
    description:
      'Set or clear the assignee of a Jira issue. Pass a display name, username or e-mail and it is resolved against the directory; pass "me" for the token\'s own account, or "unassigned" to clear it. An ambiguous name answers with the candidates rather than picking one.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Issue key, for example "ABC-1234".' },
        assignee: {
          type: 'string',
          description:
            'Display name, username, e-mail or account id. "me" assigns to the configured account; "unassigned" (or "none") clears the field.',
        },
      },
      required: ['key', 'assignee'],
    },
  },
  {
    product: 'confluence',
    write: true,
    name: 'confluence_create_page',
    description:
      'Create a Confluence (Collab) page. Write the body as plain text with Markdown-style headings, lists and fenced code blocks — it is converted to Confluence storage format. Pass parentId to nest the page under an existing one, which is where team docs almost always belong.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceKey: { type: 'string', description: 'Space key, for example "PLATFORM".' },
        title: {
          type: 'string',
          description: 'Page title. Must be unique within the space — a duplicate is rejected by Confluence.',
        },
        body: {
          type: 'string',
          description:
            'Page content. Markdown-style headings (#), bullet and numbered lists, ```fenced code blocks```, **bold** and `code` are converted.',
        },
        parentId: {
          type: 'string',
          description: 'Numeric content id of the parent page. Omit to create at the space root.',
        },
        bodyFormat: {
          type: 'string',
          enum: ['text', 'storage'],
          description:
            'How to treat body: "text" (default) converts it, "storage" passes raw Confluence storage XHTML through untouched.',
        },
      },
      required: ['spaceKey', 'title', 'body'],
    },
  },
  {
    product: 'confluence',
    write: true,
    name: 'confluence_update_page',
    description:
      'Update an existing Confluence (Collab) page. Default mode "append" adds to the end, which is the safe choice for logs and running notes; "replace" rewrites the whole body. The current version is read and incremented for you, so a concurrent edit by someone else is reported instead of being silently overwritten.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: {
          type: 'string',
          description: 'Numeric Confluence content id, from confluence_search or confluence_get_page.',
        },
        body: { type: 'string', description: 'The text to write, in the same format as confluence_create_page.' },
        mode: {
          type: 'string',
          enum: ['append', 'prepend', 'replace'],
          description: 'Where the text goes relative to the existing body. Default "append".',
        },
        title: { type: 'string', description: 'New page title. Omit to keep the current one.' },
        bodyFormat: {
          type: 'string',
          enum: ['text', 'storage'],
          description: 'How to treat body: "text" (default) converts it, "storage" passes raw storage XHTML through.',
        },
        expectedVersion: {
          type: 'number',
          description:
            'Version number you last read. When it no longer matches, the update is refused so a concurrent edit is not overwritten.',
        },
        versionMessage: {
          type: 'string',
          description: 'Short note stored in the page history, for example "Added rollback steps (ABC-1234)".',
        },
      },
      required: ['pageId', 'body'],
    },
  },
  {
    product: 'confluence',
    write: true,
    name: 'confluence_add_comment',
    description:
      'Post a comment on a Confluence (Collab) page. Use it to record a correction or a question against a spec instead of editing someone else\'s page body.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Numeric Confluence content id.' },
        body: { type: 'string', description: 'Comment text, in the same format as confluence_create_page.' },
      },
      required: ['pageId', 'body'],
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
export function listTools(
  connections: AtlassianConnections,
  options: { allowWrite?: boolean } = {},
): ToolDefinition[] {
  const configured = Boolean(connections.jira || connections.confluence);
  return ALL_TOOLS.filter((tool) => {
    // A hidden write tool cannot be picked by mistake — the strongest guard
    // available, and the reason writes are gated here rather than at the call.
    if (tool.write && !options.allowWrite) return false;
    if (!configured) return true;
    return tool.product === 'jira' ? Boolean(connections.jira) : Boolean(connections.confluence);
  }).map(({ product: _product, write: _write, ...tool }) => tool);
}

export function toolNames(
  connections: AtlassianConnections,
  options: { allowWrite?: boolean } = {},
): string[] {
  return listTools(connections, options).map((tool) => tool.name);
}

/** Raised for a bad argument. Reported as guidance, never as `isError`. */
class InvalidArgument extends Error {}

export async function callTool(
  name: string,
  rawArguments: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  const args = (rawArguments ?? {}) as Record<string, unknown>;
  const definition = ALL_TOOLS.find((tool) => tool.name === name);
  const options = { allowWrite: context.allowWrite };

  if (!definition) {
    return guidance(
      `Unknown tool "${name}". Available tools: ${toolNames(context.connections, options).join(', ') || 'none'}.`,
    );
  }
  if (definition.write && !context.allowWrite) {
    return guidance(writeDisabledMessage(name, context.envFile));
  }
  if (definition.product === 'jira' && !context.client.hasJira) {
    return guidance(notConfiguredMessage('Jira', context.envFile));
  }
  if (definition.product === 'confluence' && !context.client.hasConfluence) {
    return guidance(notConfiguredMessage('Confluence (Collab)', context.envFile));
  }

  try {
    switch (name) {
      case 'confluence_search':
        return await confluenceSearch(args, context);
      case 'confluence_get_page':
        return await confluenceGetPage(args, context);
      case 'confluence_get_page_images':
        return await confluenceGetPageImages(args, context);
      case 'jira_search':
        return await jiraSearch(args, context);
      case 'jira_get_issue':
        return await jiraGetIssue(args, context);
      case 'jira_get_comments':
        return await jiraGetComments(args, context);
      case 'jira_get_issue_images':
        return await jiraGetIssueImages(args, context);
      case 'jira_add_comment':
        return await jiraAddComment(args, context);
      case 'jira_get_transitions':
        return await jiraGetTransitions(args, context);
      case 'jira_transition_issue':
        return await jiraTransitionIssue(args, context);
      case 'jira_assign_issue':
        return await jiraAssignIssue(args, context);
      case 'confluence_create_page':
        return await confluenceCreatePage(args, context);
      case 'confluence_update_page':
        return await confluenceUpdatePage(args, context);
      case 'confluence_add_comment':
        return await confluenceAddComment(args, context);
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

// --------------------------------------------------------------- image tools

async function jiraGetIssueImages(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const key = readIssueKey(args.key);
  const attachments = await context.client.jiraAttachments(key);
  const candidates = attachments.map((attachment) => ({
    filename: attachment.filename ?? '',
    mimeType: imageMimeType(attachment.filename, attachment.mimeType),
    declaredType: attachment.mimeType ?? '',
    size: attachment.size,
    url: attachment.content ?? '',
    when: formatTimestamp(attachment.created),
    by: (attachment as JiraAttachment).author?.displayName ?? '',
  }));

  return collectImages(candidates, args, context, {
    product: 'jira',
    subject: key,
    emptyHint: `Use jira_get_issue for ${key}'s description and comments — the detail may be written out there.`,
  });
}

async function confluenceGetPageImages(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const pageId = readPageId(args.pageId);
  // Always ask for the full attachment list: `limit` caps the images returned,
  // and a page whose first attachments are PDFs would otherwise report none.
  const response = await context.client.confluenceAttachments(pageId, MAX_LIMIT);
  const candidates = (response.results ?? []).map((attachment: ConfluenceAttachment) => ({
    filename: attachment.title ?? '',
    mimeType: imageMimeType(
      attachment.title,
      attachment.metadata?.mediaType ?? attachment.extensions?.mediaType,
    ),
    declaredType: attachment.metadata?.mediaType ?? attachment.extensions?.mediaType ?? '',
    size: attachment.extensions?.fileSize,
    url: attachment._links?.download ?? '',
    when: formatTimestamp(attachment.version?.when),
    by: attachment.version?.by?.displayName ?? '',
  }));

  return collectImages(candidates, args, context, {
    product: 'confluence',
    subject: `page ${pageId}`,
    emptyHint: `Use confluence_get_page for page ${pageId} — the diagram may be described in the body text.`,
  });
}

interface AttachmentCandidate {
  filename: string;
  /** Set only when the attachment is an image; this is what makes it eligible. */
  mimeType: string | undefined;
  declaredType: string;
  size: number | undefined;
  url: string;
  when: string;
  by: string;
}

/**
 * Download the eligible attachments and build the reply.
 *
 * Shared by both products because the interesting parts — what counts as an
 * image, what happens when one is too big, and what to say when there are none
 * — are identical, and a divergence between them would be a bug either way.
 */
async function collectImages(
  candidates: AttachmentCandidate[],
  args: Record<string, unknown>,
  context: ToolContext,
  options: { product: 'jira' | 'confluence'; subject: string; emptyHint: string },
): Promise<ToolResult> {
  const wanted = optionalString(args.filename, 'filename');
  const limit = readLimit(args.limit, DEFAULT_IMAGE_LIMIT);
  const maxBytes = context.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;

  const images = candidates.filter(
    (candidate) =>
      candidate.mimeType !== undefined &&
      (!wanted || candidate.filename.toLowerCase() === wanted.toLowerCase()),
  );

  if (images.length === 0) {
    const others = candidates.map((candidate) => candidate.filename).filter(Boolean);
    if (wanted) {
      return guidance(
        [
          `No image named "${wanted}" on ${options.subject}.`,
          others.length > 0
            ? `Attachments present: ${others.join(', ')}.`
            : 'It has no attachments at all.',
        ].join('\n'),
      );
    }
    return guidance(
      [
        others.length > 0
          ? `${options.subject} has ${others.length} attachment(s), none of them images: ${others.join(', ')}.`
          : `${options.subject} has no attachments.`,
        '',
        options.emptyHint,
      ].join('\n'),
    );
  }

  const selected = images.slice(0, limit);
  const notes: string[] = [];
  const blocks: ToolContent[] = [];
  let budget = MAX_IMAGE_BYTES_PER_REPLY;

  for (const image of selected) {
    if (!image.url) {
      notes.push(`- ${image.filename} — skipped, the API returned no download link.`);
      continue;
    }
    if (typeof image.size === 'number' && image.size > maxBytes) {
      // Checked before the request: no point spending the download on a file
      // that cannot be returned anyway.
      notes.push(
        `- ${image.filename} — skipped, ${formatBytes(image.size)} is over the ${formatBytes(maxBytes)} per-image limit.`,
      );
      continue;
    }
    if (budget <= 0) {
      notes.push(`- ${image.filename} — skipped, this reply is already at its size limit.`);
      continue;
    }

    try {
      const file = await context.client.download(options.product, image.url, maxBytes);
      budget -= file.bytes.byteLength;
      blocks.push({
        type: 'image',
        data: file.bytes.toString('base64'),
        mimeType: image.mimeType ?? preferredMimeType(file.contentType),
      });
      notes.push(
        `- ${image.filename} — ${image.mimeType}${image.size ? ` · ${formatBytes(image.size)}` : ''}${image.when ? ` · added ${image.when}` : ''}${image.by ? ` by ${image.by}` : ''}`,
      );
    } catch (error) {
      // One unreadable attachment must not cost the caller the others.
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`- ${image.filename} — could not be downloaded: ${message}`);
    }
  }

  const header = [
    `# Images on ${options.subject} (${blocks.length} returned of ${images.length} image attachment(s))`,
    '',
    ...notes,
  ];
  if (images.length > selected.length) {
    header.push(
      '',
      `${images.length - selected.length} more image(s) not returned — raise limit, or name one with filename.`,
    );
  }
  if (blocks.length === 0) {
    header.push('', 'Nothing could be returned inline. The notes above say why for each file.');
  }

  return { content: [{ type: 'text', text: header.join('\n') }, ...blocks] };
}

// --------------------------------------------------------------- write tools

async function jiraAddComment(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const key = readIssueKey(args.key);
  const body = requiredString(args.body, 'body', 'jira_add_comment needs body — the comment text to post.');
  const comment = await context.client.jiraAddComment(key, body);
  const base = context.client.jiraBaseUrl ?? '';
  return text(
    [
      `Comment posted on ${key}${comment.id ? ` (id ${comment.id})` : ''}.`,
      `URL: ${base}/browse/${key}${comment.id ? `?focusedCommentId=${comment.id}` : ''}`,
      '',
      truncate(body, 500),
    ].join('\n'),
  );
}

async function jiraGetTransitions(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const key = readIssueKey(args.key);
  const transitions = (await context.client.jiraTransitions(key)).transitions ?? [];
  if (transitions.length === 0) {
    return guidance(
      `${key} offers no transitions to this account. The workflow may restrict them, or the issue may already be in a terminal status.`,
    );
  }
  return text(
    [
      `# Transitions available on ${key}`,
      '',
      ...transitions.map((transition) => describeTransition(transition)),
      '',
      'Apply one with jira_transition_issue (transition: the name, or transitionId: the id).',
    ].join('\n'),
  );
}

async function jiraTransitionIssue(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const key = readIssueKey(args.key);
  const requestedId = optionalString(args.transitionId, 'transitionId');
  const requestedName = optionalString(args.transition, 'transition');
  const comment = optionalString(args.comment, 'comment');

  if (!requestedId && !requestedName) {
    throw new InvalidArgument(
      'jira_transition_issue needs transition (a name or target status) or transitionId. Call jira_get_transitions to see what the workflow offers.',
    );
  }

  const transitions = (await context.client.jiraTransitions(key)).transitions ?? [];
  if (transitions.length === 0) {
    return guidance(
      `${key} offers no transitions to this account, so it cannot be moved. The workflow may restrict them, or the issue may already be in a terminal status.`,
    );
  }

  const match = matchTransition(transitions, requestedId, requestedName);
  if (!match) {
    return guidance(
      [
        `"${requestedId ?? requestedName}" is not available on ${key} right now. A Jira workflow only offers the transitions valid from the current status.`,
        '',
        'Available:',
        ...transitions.map((transition) => describeTransition(transition)),
      ].join('\n'),
    );
  }

  await context.client.jiraTransition(key, String(match.id), comment);

  // Read the status back: the workflow may run a post-function that lands the
  // issue somewhere other than the transition's nominal target.
  let landed = match.to?.name ?? '(unknown)';
  try {
    const issue = await context.client.jiraIssue(key, ['status', 'assignee']);
    landed =
      fieldString((issue.fields?.status as { name?: string } | undefined)?.name) || landed;
  } catch {
    // The transition already succeeded; a failed confirmation read is not worth
    // reporting as a failure.
  }

  const base = context.client.jiraBaseUrl ?? '';
  return text(
    [
      `${key} transitioned via "${match.name ?? match.id}". Status is now ${landed}.`,
      comment ? 'The comment was posted with the transition.' : '',
      `URL: ${base}/browse/${key}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

async function jiraAssignIssue(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const key = readIssueKey(args.key);
  const requested = requiredString(
    args.assignee,
    'assignee',
    'jira_assign_issue needs assignee — a name, e-mail, "me", or "unassigned".',
  );
  const base = context.client.jiraBaseUrl ?? '';

  if (/^(unassigned|none|null)$/i.test(requested)) {
    await context.client.jiraAssign(key, null);
    return text(`${key} is now unassigned.\nURL: ${base}/browse/${key}`);
  }

  let user: JiraUser | undefined;
  if (/^me$/i.test(requested)) {
    user = await context.client.jiraWhoAmI();
  } else {
    const matches = await context.client.jiraFindUsers(requested);
    const active = matches.filter((candidate) => candidate.active !== false);
    const pool = active.length > 0 ? active : matches;
    const exact = pool.filter((candidate) => isExactUserMatch(candidate, requested));
    const shortlist = exact.length > 0 ? exact : pool;

    if (shortlist.length === 0) {
      return guidance(
        `No Jira user matches "${requested}". Try the e-mail address, the exact display name, or the account id — the directory search does not match partial words in every deployment.`,
      );
    }
    if (shortlist.length > 1) {
      return guidance(
        [
          `"${requested}" matches ${shortlist.length} users. Call jira_assign_issue again with one of these exactly:`,
          '',
          ...shortlist.map((candidate) => `- ${describeUser(candidate)}`),
        ].join('\n'),
      );
    }
    user = shortlist[0];
  }

  await context.client.jiraAssign(key, user ?? null);
  return text(
    [`${key} is now assigned to ${describeUser(user)}.`, `URL: ${base}/browse/${key}`].join('\n'),
  );
}

async function confluenceCreatePage(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const spaceKey = requiredString(
    args.spaceKey,
    'spaceKey',
    'confluence_create_page needs spaceKey — the space the page belongs in, for example "PLATFORM".',
  );
  const title = requiredString(args.title, 'title', 'confluence_create_page needs title.');
  const storage = readBody(args, 'confluence_create_page needs body — the page content.');
  const parentId = optionalString(args.parentId, 'parentId');
  if (parentId && !/^\d+$/.test(parentId)) {
    throw new InvalidArgument(
      `parentId must be the numeric Confluence content id, got "${parentId}".`,
    );
  }

  const page = await context.client.confluenceCreatePage({
    spaceKey,
    title,
    storage,
    parentId,
  });
  const base = context.client.confluenceBaseUrl ?? '';
  return text(
    [
      `Created "${page.title ?? title}" in space ${spaceKey}.`,
      `pageId: ${page.id ?? '(unknown)'}`,
      ...(page._links?.webui
        ? [`URL: ${base}${page._links.webui.startsWith('/') ? '' : '/'}${page._links.webui}`]
        : []),
      parentId ? `Nested under page ${parentId}.` : 'Created at the space root.',
    ].join('\n'),
  );
}

async function confluenceUpdatePage(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const pageId = readPageId(args.pageId);
  const addition = readBody(args, 'confluence_update_page needs body — the text to write.');
  const mode = readMode(args.mode);
  const newTitle = optionalString(args.title, 'title');
  const versionMessage = optionalString(args.versionMessage, 'versionMessage');
  const expectedVersion =
    args.expectedVersion === undefined ? undefined : Number(args.expectedVersion);

  const page = await context.client.confluencePage(pageId);
  const currentVersion = page.version?.number;
  if (typeof currentVersion !== 'number') {
    return guidance(
      `Confluence did not report a version number for page ${pageId}, so it cannot be updated safely. Check the id with confluence_get_page.`,
    );
  }
  if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
    return guidance(
      `Page ${pageId} is at version ${currentVersion}, not the expected ${expectedVersion} — someone edited it in the meantime. Re-read it with confluence_get_page and reapply the change on top of their edit.`,
    );
  }

  const existing = page.body?.storage?.value ?? '';
  const storage =
    mode === 'replace'
      ? addition
      : mode === 'prepend'
        ? `${addition}${existing}`
        : `${existing}${addition}`;

  const updated = await context.client.confluenceUpdatePage({
    pageId,
    title: newTitle ?? page.title ?? '',
    storage,
    currentVersion,
    type: page.type,
    versionMessage,
  });

  const base = context.client.confluenceBaseUrl ?? '';
  return text(
    [
      `Updated "${updated.title ?? page.title}" (${mode}). Version ${currentVersion} → ${updated.version?.number ?? currentVersion + 1}.`,
      ...(updated._links?.webui
        ? [`URL: ${base}${updated._links.webui.startsWith('/') ? '' : '/'}${updated._links.webui}`]
        : []),
    ].join('\n'),
  );
}

async function confluenceAddComment(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const pageId = readPageId(args.pageId);
  const storage = readBody(args, 'confluence_add_comment needs body — the comment text.');
  const comment = await context.client.confluenceAddComment(pageId, storage);
  return text(
    `Comment posted on page ${pageId}${comment.id ? ` (id ${comment.id})` : ''}.`,
  );
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

/** Media types an MCP client can actually render. */
const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
]);

const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};

/**
 * The media type to return an attachment as, or `undefined` when it is not an
 * image.
 *
 * The declared type is trusted when it is a known image type, and the filename
 * decides otherwise: plenty of Jira instances store every upload as
 * `application/octet-stream`, and dropping those would hide exactly the
 * screenshots this tool exists for.
 */
export function imageMimeType(
  filename: string | undefined,
  declaredType: string | undefined,
): string | undefined {
  const declared = (declaredType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (declared === 'image/jpg') return 'image/jpeg';
  if (IMAGE_MIME_TYPES.has(declared)) return declared;

  const extension = /\.([a-z0-9]+)$/i.exec(filename ?? '')?.[1]?.toLowerCase();
  if (!extension) return undefined;
  const fromExtension = IMAGE_EXTENSIONS[extension];
  if (!fromExtension) return undefined;

  // A declared non-image type that is specific (text/plain, application/pdf)
  // beats the extension; only the ambiguous ones fall through to it.
  const ambiguous = declared === '' || declared === 'application/octet-stream';
  return ambiguous ? fromExtension : undefined;
}

/** Fall back to the served content type, but never to a non-image. */
function preferredMimeType(contentType: string): string {
  const served = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return IMAGE_MIME_TYPES.has(served) ? served : 'image/png';
}

function describeTransition(transition: JiraTransition): string {
  const target = transition.to?.name ? ` → ${transition.to.name}` : '';
  const screen = transition.hasScreen ? ' (opens a screen; required fields may block it)' : '';
  return `- ${transition.name ?? '(unnamed)'}${target} [id ${transition.id ?? '?'}]${screen}`;
}

/**
 * Resolve what the caller asked for against what the workflow offers. An id
 * wins; otherwise the transition name is matched first, then the target status
 * — agents say "move it to Done" at least as often as they name the transition.
 */
function matchTransition(
  transitions: readonly JiraTransition[],
  id: string | undefined,
  name: string | undefined,
): JiraTransition | undefined {
  if (id) return transitions.find((transition) => String(transition.id) === id);
  const wanted = (name ?? '').trim().toLowerCase();
  return (
    transitions.find((transition) => (transition.name ?? '').toLowerCase() === wanted) ??
    transitions.find((transition) => (transition.to?.name ?? '').toLowerCase() === wanted)
  );
}

function describeUser(user: JiraUser | undefined): string {
  if (!user) return '(nobody)';
  const identity = user.accountId ?? user.name ?? user.key ?? '';
  const details = [user.emailAddress, identity].filter(Boolean).join(' · ');
  const label = user.displayName || identity || 'unknown user';
  return `${label}${details ? ` (${details})` : ''}`;
}

function isExactUserMatch(user: JiraUser, requested: string): boolean {
  const wanted = requested.trim().toLowerCase();
  return [user.accountId, user.name, user.key, user.emailAddress, user.displayName].some(
    (value) => typeof value === 'string' && value.toLowerCase() === wanted,
  );
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

function readPageId(value: unknown): string {
  const pageId = optionalString(value, 'pageId');
  if (!pageId) {
    throw new InvalidArgument(
      'pageId is required. Get it from confluence_search or from a confluence_get_page reply.',
    );
  }
  if (!/^\d+$/.test(pageId)) {
    throw new InvalidArgument(
      `pageId must be the numeric Confluence content id, got "${pageId}". Use confluence_search to find it.`,
    );
  }
  return pageId;
}

function requiredString(value: unknown, name: string, message: string): string {
  const text = optionalString(value, name);
  if (!text) throw new InvalidArgument(message);
  return text;
}

/**
 * Read a body argument into storage format. `bodyFormat: "storage"` is an
 * escape hatch for content that is already XHTML (a macro, a table); everything
 * else is converted, because that is what an agent writes by default.
 */
function readBody(args: Record<string, unknown>, message: string): string {
  const body = requiredString(args.body, 'body', message);
  const format = optionalString(args.bodyFormat, 'bodyFormat')?.toLowerCase() ?? 'text';
  if (format === 'storage') return body;
  if (format !== 'text') {
    throw new InvalidArgument(`bodyFormat must be "text" or "storage", got "${format}".`);
  }
  return textToStorage(body);
}

function readMode(value: unknown): 'append' | 'prepend' | 'replace' {
  const mode = optionalString(value, 'mode')?.toLowerCase() ?? 'append';
  if (mode === 'append' || mode === 'prepend' || mode === 'replace') return mode;
  throw new InvalidArgument(
    `mode must be "append", "prepend" or "replace", got "${mode}". Default is "append".`,
  );
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

/**
 * The reply for a write tool that was named while writing is disabled.
 *
 * It is guidance, not an error: the agent did nothing wrong, and the fix is a
 * user decision. It also says plainly not to retry, so the agent falls back to
 * reporting the change for a human to make rather than looping on a tool that
 * will not work this session.
 */
export function writeDisabledMessage(name: string, envFile: string): string {
  return [
    `"${name}" changes real Jira or Confluence data, and write access is turned off for CodeBrain, so nothing was sent.`,
    '',
    'To enable it, the user turns on "CodeBrain › Atlassian: Allow Write" in VS Code settings,',
    `or sets CODEBRAIN_ATLASSIAN_ALLOW_WRITE=1 in ${envFile}.`,
    '',
    'Until then, do not retry any write tool in this session. Read tools still work — report the change you would have made so the user can apply it.',
  ].join('\n');
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
