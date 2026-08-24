/**
 * Read-only REST client for Jira and Confluence (Collab).
 *
 * Covers both deployment flavours because the same personal-token setup is
 * used against either:
 *
 *   - **Server / Data Center** — `Bearer <personal access token>`, Jira REST
 *     v2, Confluence REST v1.
 *   - **Cloud** — Basic `email:api-token` (so a `*_USERNAME` value switches
 *     auth), Jira REST v3 with the `search/jql` endpoint that replaced
 *     `/search`.
 *
 * Only GET requests exist here on purpose: the MCP surface is read-only, so
 * there is no code path that can modify an issue or a page even if an agent
 * asks for it.
 */

import { AtlassianConnections, AtlassianEndpoint } from './connection';

/** A failed HTTP call, carrying enough context to be actionable in a tool reply. */
export class AtlassianRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body: string = '',
  ) {
    super(message);
    this.name = 'AtlassianRequestError';
  }
}

/**
 * Identify a request failure by name rather than by `instanceof`.
 *
 * `instanceof` silently stops matching whenever two copies of this module end
 * up in one process — a bundling accident, a test harness with its own module
 * cache — and the failure mode is bad: a recoverable HTTP error would be
 * reported to the agent as a server malfunction, which is exactly the reply
 * that makes it stop calling the server at all.
 */
export function isAtlassianRequestError(value: unknown): value is AtlassianRequestError {
  return value instanceof Error && value.name === 'AtlassianRequestError';
}

export interface JiraIssue {
  key: string;
  fields?: Record<string, unknown>;
}

export interface JiraSearchResponse {
  issues?: JiraIssue[];
  total?: number;
}

export interface JiraComment {
  id?: string;
  author?: { displayName?: string };
  created?: string;
  updated?: string;
  body?: unknown;
}

export interface JiraCommentsResponse {
  comments?: JiraComment[];
  total?: number;
}

export interface ConfluenceContent {
  id?: string;
  type?: string;
  title?: string;
  space?: { key?: string; name?: string };
  version?: { number?: number; when?: string; by?: { displayName?: string } };
  history?: { lastUpdated?: { when?: string; by?: { displayName?: string } } };
  body?: { storage?: { value?: string } };
  excerpt?: string;
  _links?: { webui?: string; tinyui?: string };
}

export interface ConfluenceSearchResponse {
  results?: ConfluenceContent[];
  size?: number;
  totalSize?: number;
}

export interface AtlassianClientOptions {
  connections: AtlassianConnections;
  /** Injected in tests; defaults to the runtime's global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ERROR_BODY_CHARACTERS = 600;

/** Cloud tenants live on `atlassian.net` and need the newer Jira endpoints. */
export function isCloudUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith('.atlassian.net');
  } catch {
    return false;
  }
}

/**
 * Auth header for an endpoint. A username means an API token pair (Cloud),
 * anything else is a Server/DC personal access token used as a bearer.
 */
export function authorizationHeader(endpoint: AtlassianEndpoint): string {
  if (endpoint.username) {
    const encoded = Buffer.from(
      `${endpoint.username}:${endpoint.token}`,
      'utf8',
    ).toString('base64');
    return `Basic ${encoded}`;
  }
  return `Bearer ${endpoint.token}`;
}

export class AtlassianClient {
  private readonly connections: AtlassianConnections;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AtlassianClientOptions) {
    this.connections = options.connections;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get hasJira(): boolean {
    return Boolean(this.connections.jira);
  }

  get hasConfluence(): boolean {
    return Boolean(this.connections.confluence);
  }

  get jiraBaseUrl(): string | undefined {
    return this.connections.jira?.baseUrl;
  }

  get confluenceBaseUrl(): string | undefined {
    return this.connections.confluence?.baseUrl;
  }

  // ---------------------------------------------------------------- Jira

  /** `/rest/api/2` on Server/DC, `/rest/api/3` on Cloud. */
  private jiraApi(): string {
    return isCloudUrl(this.requireJira().baseUrl) ? '3' : '2';
  }

  async jiraSearch(options: {
    jql: string;
    limit: number;
    fields?: readonly string[];
  }): Promise<JiraSearchResponse> {
    const jira = this.requireJira();
    const fields = (options.fields ?? DEFAULT_JIRA_SEARCH_FIELDS).join(',');
    // Cloud removed `/search` in favour of `/search/jql`; Server/DC only has
    // the former, so the path follows the deployment.
    const path = isCloudUrl(jira.baseUrl)
      ? '/rest/api/3/search/jql'
      : '/rest/api/2/search';
    return this.get<JiraSearchResponse>(jira, path, {
      jql: options.jql,
      maxResults: String(options.limit),
      fields,
    });
  }

  async jiraIssue(key: string, fields?: readonly string[]): Promise<JiraIssue> {
    const jira = this.requireJira();
    return this.get<JiraIssue>(jira, `/rest/api/${this.jiraApi()}/issue/${encodeURIComponent(key)}`, {
      fields: (fields ?? DEFAULT_JIRA_ISSUE_FIELDS).join(','),
    });
  }

  async jiraComments(key: string, limit: number): Promise<JiraCommentsResponse> {
    const jira = this.requireJira();
    return this.get<JiraCommentsResponse>(
      jira,
      `/rest/api/${this.jiraApi()}/issue/${encodeURIComponent(key)}/comment`,
      { maxResults: String(limit), orderBy: '-created' },
    );
  }

  /** Cheap authenticated call used to verify the token works. */
  async jiraWhoAmI(): Promise<{ displayName?: string; name?: string; emailAddress?: string }> {
    const jira = this.requireJira();
    return this.get(jira, `/rest/api/${this.jiraApi()}/myself`, {});
  }

  // ---------------------------------------------------------- Confluence

  async confluenceSearch(options: {
    cql: string;
    limit: number;
  }): Promise<ConfluenceSearchResponse> {
    const confluence = this.requireConfluence();
    return this.get<ConfluenceSearchResponse>(confluence, '/rest/api/content/search', {
      cql: options.cql,
      limit: String(options.limit),
      expand: 'space,version,history.lastUpdated',
    });
  }

  async confluencePage(pageId: string): Promise<ConfluenceContent> {
    const confluence = this.requireConfluence();
    return this.get<ConfluenceContent>(
      confluence,
      `/rest/api/content/${encodeURIComponent(pageId)}`,
      { expand: 'body.storage,space,version,history.lastUpdated' },
    );
  }

  async confluencePageByTitle(
    title: string,
    spaceKey?: string,
  ): Promise<ConfluenceSearchResponse> {
    const confluence = this.requireConfluence();
    return this.get<ConfluenceSearchResponse>(confluence, '/rest/api/content', {
      title,
      ...(spaceKey ? { spaceKey } : {}),
      expand: 'body.storage,space,version,history.lastUpdated',
      limit: '5',
    });
  }

  /** Cheap authenticated call used to verify the token works. */
  async confluenceProbe(): Promise<{ results?: unknown[] }> {
    const confluence = this.requireConfluence();
    return this.get(confluence, '/rest/api/space', { limit: '1' });
  }

  // ------------------------------------------------------------- plumbing

  private requireJira(): AtlassianEndpoint {
    const jira = this.connections.jira;
    if (!jira) throw new Error('Jira is not configured.');
    return jira;
  }

  private requireConfluence(): AtlassianEndpoint {
    const confluence = this.connections.confluence;
    if (!confluence) throw new Error('Confluence is not configured.');
    return confluence;
  }

  private async get<T>(
    endpoint: AtlassianEndpoint,
    path: string,
    query: Record<string, string>,
  ): Promise<T> {
    const url = new URL(endpoint.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: authorizationHeader(endpoint),
          Accept: 'application/json',
          'User-Agent': 'CodeBrain-Atlassian-MCP',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A network-level failure never reaches the status-code branch below, so
      // the reachability hint has to be attached here.
      throw new AtlassianRequestError(
        `Could not reach ${url.host}: ${reason}. Check the URL, your VPN/proxy, and CODEBRAIN_ATLASSIAN_SSL_VERIFY if the host uses a private certificate authority.`,
        0,
        url.toString(),
      );
    }

    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new AtlassianRequestError(
        `${response.status} ${response.statusText} from ${url.pathname}${describeStatus(response.status)}${body ? ` — ${body}` : ''}`,
        response.status,
        url.toString(),
        body,
      );
    }

    return (await response.json()) as T;
  }
}

export const DEFAULT_JIRA_SEARCH_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'priority',
  'assignee',
  'reporter',
  'updated',
  'created',
  'labels',
  'components',
  'fixVersions',
] as const;

export const DEFAULT_JIRA_ISSUE_FIELDS = [
  ...DEFAULT_JIRA_SEARCH_FIELDS,
  'description',
  'parent',
  'subtasks',
  'issuelinks',
  'resolution',
  'duedate',
] as const;

function describeStatus(status: number): string {
  switch (status) {
    case 401:
      return ' — the personal access token was rejected. Re-run "CodeBrain: Configure Atlassian (Collab + Jira)".';
    case 403:
      return ' — authenticated, but this token lacks permission for that project or space.';
    case 404:
      return ' — no such issue, page, or endpoint. Check the id and the base URL (Confluence Cloud needs the /wiki context path).';
    case 429:
      return ' — rate limited by the server. Retry in a moment.';
    default:
      return '';
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_BODY_CHARACTERS);
  } catch {
    return '';
  }
}
