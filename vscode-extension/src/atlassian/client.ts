/**
 * REST client for Jira and Confluence (Collab).
 *
 * Covers both deployment flavours because the same personal-token setup is
 * used against either:
 *
 *   - **Server / Data Center** — `Bearer <personal access token>`, Jira REST
 *     v2, Confluence REST v1.
 *   - **Cloud** — Basic `email:api-token` (so a `*_USERNAME` value switches
 *     auth), Jira REST v3 with the `search/jql` endpoint that replaced
 *     `/search`, and ADF node trees where Server/DC takes a plain string.
 *
 * Reads and writes are separated by construction: {@link AtlassianClient.get}
 * is the only path most methods take, and every mutating method goes through
 * {@link AtlassianClient.send}. Whether the mutating methods are reachable at
 * all is decided one layer up, in `tools.ts` — the tool surface hides them
 * unless write access was explicitly enabled.
 */

import { AtlassianConnections, AtlassianEndpoint } from './connection';
import { textToAdf } from './format';

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

/** One file attached to a Jira issue. `content` is an absolute download URL. */
export interface JiraAttachment {
  id?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  created?: string;
  author?: { displayName?: string };
  content?: string;
}

/** One workflow transition available from an issue's current status. */
export interface JiraTransition {
  id?: string;
  name?: string;
  to?: { name?: string };
  hasScreen?: boolean;
  fields?: Record<string, unknown>;
}

export interface JiraTransitionsResponse {
  transitions?: JiraTransition[];
}

/** A user as returned by either deployment's user search. */
export interface JiraUser {
  accountId?: string;
  name?: string;
  key?: string;
  displayName?: string;
  emailAddress?: string;
  active?: boolean;
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

/** One file attached to a Confluence page. */
export interface ConfluenceAttachment {
  id?: string;
  title?: string;
  metadata?: { mediaType?: string };
  extensions?: { fileSize?: number; mediaType?: string };
  version?: { when?: string; by?: { displayName?: string } };
  _links?: { download?: string };
}

export interface ConfluenceAttachmentsResponse {
  results?: ConfluenceAttachment[];
  size?: number;
}

/** A downloaded binary, ready to be base64-encoded into an MCP image block. */
export interface DownloadedFile {
  bytes: Buffer;
  contentType: string;
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
  async jiraWhoAmI(): Promise<JiraUser> {
    const jira = this.requireJira();
    return this.get(jira, `/rest/api/${this.jiraApi()}/myself`, {});
  }

  /** True when Jira is a Cloud tenant, which changes body shapes and user ids. */
  get jiraIsCloud(): boolean {
    return isCloudUrl(this.requireJira().baseUrl);
  }

  async jiraAttachments(key: string): Promise<JiraAttachment[]> {
    const jira = this.requireJira();
    const issue = await this.get<JiraIssue>(
      jira,
      `/rest/api/${this.jiraApi()}/issue/${encodeURIComponent(key)}`,
      { fields: 'attachment' },
    );
    const attachments = issue.fields?.attachment;
    return Array.isArray(attachments) ? (attachments as JiraAttachment[]) : [];
  }

  async jiraTransitions(key: string): Promise<JiraTransitionsResponse> {
    const jira = this.requireJira();
    return this.get<JiraTransitionsResponse>(
      jira,
      `/rest/api/${this.jiraApi()}/issue/${encodeURIComponent(key)}/transitions`,
      { expand: 'transitions.fields' },
    );
  }

  /** Find users by name, e-mail or account id, for resolving an assignee. */
  async jiraFindUsers(query: string): Promise<JiraUser[]> {
    const jira = this.requireJira();
    // Cloud searches with `query`; Server/DC only understands `username`.
    const path = `/rest/api/${this.jiraApi()}/user/search`;
    const parameters: Record<string, string> = this.jiraIsCloud
      ? { query, maxResults: '10' }
      : { username: query, maxResults: '10' };
    const users = await this.get<JiraUser[]>(jira, path, parameters);
    return Array.isArray(users) ? users : [];
  }

  // ------------------------------------------------------------ Jira writes

  async jiraAddComment(key: string, body: string): Promise<JiraComment> {
    const jira = this.requireJira();
    return this.send<JiraComment>(
      jira,
      'POST',
      `/rest/api/${this.jiraApi()}/issue/${encodeURIComponent(key)}/comment`,
      { body: this.jiraTextBody(body) },
    );
  }

  /** Apply a transition, optionally attaching a comment in the same request. */
  async jiraTransition(key: string, transitionId: string, comment?: string): Promise<void> {
    const jira = this.requireJira();
    const payload: Record<string, unknown> = { transition: { id: transitionId } };
    if (comment) {
      payload.update = { comment: [{ add: { body: this.jiraTextBody(comment) } }] };
    }
    await this.send<void>(
      jira,
      'POST',
      `/rest/api/${this.jiraApi()}/issue/${encodeURIComponent(key)}/transitions`,
      payload,
    );
  }

  /**
   * Set (or with `null`, clear) the assignee. Cloud identifies a user by
   * `accountId`, Server/DC by `name` — sending the wrong one is accepted as a
   * 204 that silently changes nothing, so the shape follows the deployment.
   */
  async jiraAssign(key: string, user: JiraUser | null): Promise<void> {
    const jira = this.requireJira();
    const payload = this.jiraIsCloud
      ? { accountId: user?.accountId ?? null }
      : { name: user?.name ?? user?.key ?? null };
    await this.send<void>(
      jira,
      'PUT',
      `/rest/api/${this.jiraApi()}/issue/${encodeURIComponent(key)}/assignee`,
      payload,
    );
  }

  /** Cloud takes an ADF document where Server/DC takes wiki-markup text. */
  private jiraTextBody(text: string): unknown {
    return this.jiraIsCloud ? textToAdf(text) : text;
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

  async confluenceAttachments(
    pageId: string,
    limit: number,
  ): Promise<ConfluenceAttachmentsResponse> {
    const confluence = this.requireConfluence();
    return this.get<ConfluenceAttachmentsResponse>(
      confluence,
      `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`,
      { limit: String(limit), expand: 'version,metadata,extensions' },
    );
  }

  /** Cheap authenticated call used to verify the token works. */
  async confluenceProbe(): Promise<{ results?: unknown[] }> {
    const confluence = this.requireConfluence();
    return this.get(confluence, '/rest/api/space', { limit: '1' });
  }

  // ------------------------------------------------------ Confluence writes

  async confluenceCreatePage(options: {
    spaceKey: string;
    title: string;
    storage: string;
    parentId?: string;
  }): Promise<ConfluenceContent> {
    const confluence = this.requireConfluence();
    return this.send<ConfluenceContent>(confluence, 'POST', '/rest/api/content', {
      type: 'page',
      title: options.title,
      space: { key: options.spaceKey },
      ...(options.parentId ? { ancestors: [{ id: options.parentId }] } : {}),
      body: { storage: { value: options.storage, representation: 'storage' } },
    });
  }

  /**
   * Replace a page's body. Confluence uses the version number for optimistic
   * locking: `version.number` must be exactly one past the current one, so the
   * caller passes the version it actually read and a concurrent edit fails
   * loudly instead of silently overwriting someone's work.
   */
  async confluenceUpdatePage(options: {
    pageId: string;
    title: string;
    storage: string;
    currentVersion: number;
    type?: string;
    versionMessage?: string;
  }): Promise<ConfluenceContent> {
    const confluence = this.requireConfluence();
    return this.send<ConfluenceContent>(
      confluence,
      'PUT',
      `/rest/api/content/${encodeURIComponent(options.pageId)}`,
      {
        id: options.pageId,
        type: options.type ?? 'page',
        title: options.title,
        version: {
          number: options.currentVersion + 1,
          ...(options.versionMessage ? { message: options.versionMessage } : {}),
        },
        body: { storage: { value: options.storage, representation: 'storage' } },
      },
    );
  }

  /** A page comment is itself content of type `comment`, contained by the page. */
  async confluenceAddComment(pageId: string, storage: string): Promise<ConfluenceContent> {
    const confluence = this.requireConfluence();
    return this.send<ConfluenceContent>(confluence, 'POST', '/rest/api/content', {
      type: 'comment',
      container: { id: pageId, type: 'page' },
      body: { storage: { value: storage, representation: 'storage' } },
    });
  }

  // ------------------------------------------------------------- downloads

  /**
   * Fetch an attachment as bytes.
   *
   * The URL comes from an API payload, so it is checked against the configured
   * base URL before the token is attached: a crafted attachment record must not
   * be able to send a personal access token to another host.
   */
  async download(
    product: 'jira' | 'confluence',
    url: string,
    maxBytes: number,
  ): Promise<DownloadedFile> {
    const endpoint = product === 'jira' ? this.requireJira() : this.requireConfluence();
    const target = this.resolveAttachmentUrl(endpoint, url);

    let response: Response;
    try {
      response = await this.fetchImpl(target.toString(), {
        method: 'GET',
        headers: {
          Authorization: authorizationHeader(endpoint),
          Accept: '*/*',
          'User-Agent': 'CodeBrain-Atlassian-MCP',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new AtlassianRequestError(
        `Could not download ${target.pathname} from ${target.host}: ${reason}.`,
        0,
        target.toString(),
      );
    }

    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new AtlassianRequestError(
        `${response.status} ${response.statusText} downloading ${target.pathname}${describeStatus(response.status)}${body ? ` — ${body}` : ''}`,
        response.status,
        target.toString(),
        body,
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new AtlassianRequestError(
        `The file is ${bytes.byteLength} bytes, over the ${maxBytes}-byte limit.`,
        413,
        target.toString(),
      );
    }
    return {
      bytes,
      contentType: response.headers?.get?.('content-type') ?? 'application/octet-stream',
    };
  }

  /**
   * Absolute URLs must stay on the configured host; relative ones are joined to
   * it. A root-relative link (`/download/attachments/…`, which is what
   * Confluence returns) is resolved against the base URL **including its
   * context path** — plain URL joining would drop the `/wiki` that Confluence
   * Cloud needs and turn every download into a 404.
   */
  private resolveAttachmentUrl(endpoint: AtlassianEndpoint, url: string): URL {
    const base = new URL(endpoint.baseUrl);
    const basePath = base.pathname.replace(/\/+$/, '');
    let target: URL;
    try {
      if (url.startsWith('/')) {
        const path = basePath && !url.startsWith(`${basePath}/`) ? `${basePath}${url}` : url;
        target = new URL(`${base.origin}${path}`);
      } else {
        target = new URL(url, `${base.origin}${basePath}/`);
      }
    } catch {
      throw new AtlassianRequestError(`"${url}" is not a usable attachment URL.`, 0, url);
    }
    if (target.host !== base.host) {
      throw new AtlassianRequestError(
        `Refusing to send credentials to ${target.host}: attachments must live on ${base.host}.`,
        0,
        target.toString(),
      );
    }
    return target;
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

  private get<T>(
    endpoint: AtlassianEndpoint,
    path: string,
    query: Record<string, string>,
  ): Promise<T> {
    return this.request<T>(endpoint, 'GET', path, { query });
  }

  /**
   * A mutating request. Separate from {@link get} only so that every write in
   * this file is greppable — the transport underneath is the same.
   */
  private send<T>(
    endpoint: AtlassianEndpoint,
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
  ): Promise<T> {
    return this.request<T>(endpoint, method, path, { body });
  }

  private async request<T>(
    endpoint: AtlassianEndpoint,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(endpoint.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }

    const hasBody = options.body !== undefined;
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: authorizationHeader(endpoint),
          Accept: 'application/json',
          'User-Agent': 'CodeBrain-Atlassian-MCP',
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          // Confluence and Jira reject a non-GET without this header when the
          // session also carries a cookie; harmless otherwise.
          ...(method === 'GET' ? {} : { 'X-Atlassian-Token': 'no-check' }),
        },
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
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

    // A successful write commonly answers 204 with an empty body — assignee and
    // transition both do. Parsing that as JSON would throw and turn a change
    // that landed into a reported malfunction.
    if (response.status === 204 || response.status === 205) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch (error) {
      if (method === 'GET') {
        const reason = error instanceof Error ? error.message : String(error);
        throw new AtlassianRequestError(
          `${url.pathname} did not return JSON (${reason}). Check that the base URL points at the API root and not at a login or proxy page.`,
          response.status,
          url.toString(),
        );
      }
      return undefined as T;
    }
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
