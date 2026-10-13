export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;
const LINEAR_GRAPHQL = 'https://api.linear.app/graphql';
const SLACK_API = 'https://slack.com/api';
const GITHUB_API = 'https://api.github.com';

export class IntegrationApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string | null;
  branchName: string | null;
  labels: string[];
  state: string | null;
  updatedAt: string | null;
  creatorId: string | null;
}

export interface LinearViewer {
  id: string;
  name: string | null;
  organizationName: string | null;
}

const ISSUE_FIELDS = `id identifier title description url branchName updatedAt creator { id } state { name type } labels { nodes { name } }`;
const OPEN_FILTER = `{ state: { type: { nin: ["completed", "canceled"] } } }`;

function toLinearIssue(node: any): LinearIssue | null {
  if (!node || typeof node.id !== 'string' || typeof node.title !== 'string') return null;
  return {
    id: node.id,
    identifier: typeof node.identifier === 'string' ? node.identifier : node.id,
    title: node.title,
    description: typeof node.description === 'string' ? node.description : null,
    url: typeof node.url === 'string' ? node.url : null,
    branchName: typeof node.branchName === 'string' ? node.branchName : null,
    labels: Array.isArray(node.labels?.nodes)
      ? node.labels.nodes.map((l: any) => String(l?.name ?? '')).filter(Boolean)
      : [],
    state: typeof node.state?.name === 'string' ? node.state.name : null,
    updatedAt: typeof node.updatedAt === 'string' ? node.updatedAt : null,
    creatorId: typeof node.creator?.id === 'string' ? node.creator.id : null
  };
}

export class LinearClient {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async graphql(apiKey: string, query: string, variables: Record<string, unknown> = {}) {
    const res = await this.fetchImpl(LINEAR_GRAPHQL, {
      method: 'POST',
      headers: {
        authorization: apiKey,
        'content-type': 'application/json',
        'user-agent': 'orchard-greenhouse'
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const body = await readJson(res);
    if (res.status === 401 || res.status === 403) {
      throw new IntegrationApiError('Linear rejected the API key', res.status);
    }
    if (!res.ok || !body || (Array.isArray(body.errors) && body.errors.length && !body.data)) {
      const message = body?.errors?.[0]?.message;
      throw new IntegrationApiError(
        message ? `Linear: ${String(message).slice(0, 200)}` : 'Linear request failed',
        res.status
      );
    }
    return body.data;
  }

  async viewer(apiKey: string): Promise<LinearViewer> {
    const data = await this.graphql(apiKey, `query { viewer { id name organization { name } } }`);
    const viewer = data?.viewer;
    if (!viewer || typeof viewer.id !== 'string') {
      throw new IntegrationApiError('Linear did not return the account for this key', 400);
    }
    return {
      id: viewer.id,
      name: typeof viewer.name === 'string' ? viewer.name : null,
      organizationName:
        typeof viewer.organization?.name === 'string' ? viewer.organization.name : null
    };
  }

  async issue(apiKey: string, id: string): Promise<LinearIssue | null> {
    const data = await this.graphql(
      apiKey,
      `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id }
    );
    return toLinearIssue(data?.issue);
  }

  async openIssues(apiKey: string, q: string): Promise<LinearIssue[]> {
    const term = q.trim();
    if (!term) {
      const data = await this.graphql(
        apiKey,
        `query { viewer { assignedIssues(first: 30, orderBy: updatedAt, filter: ${OPEN_FILTER}) { nodes { ${ISSUE_FIELDS} } } } }`
      );
      const nodes = data?.viewer?.assignedIssues?.nodes;
      return Array.isArray(nodes)
        ? nodes.map(toLinearIssue).filter((i): i is LinearIssue => !!i)
        : [];
    }
    const data = await this.graphql(
      apiKey,
      `query Search($q: String!) { issues(first: 30, orderBy: updatedAt, filter: { title: { containsIgnoreCase: $q }, state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${ISSUE_FIELDS} } } }`,
      { q: term.slice(0, 200) }
    );
    const nodes = data?.issues?.nodes;
    return Array.isArray(nodes)
      ? nodes.map(toLinearIssue).filter((i): i is LinearIssue => !!i)
      : [];
  }

  async comment(apiKey: string, issueId: string, body: string, parentId?: string | null) {
    await this.graphql(
      apiKey,
      `mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId, body, ...(parentId ? { parentId } : {}) } }
    );
  }
}

export class SlackClient {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  private async call(token: string, method: string, init: { body?: unknown }) {
    const url = `${SLACK_API}/${method}`;
    const res = await this.fetchImpl(url, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json; charset=utf-8' } : {})
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const body = await readJson(res);
    if (!res.ok || !body?.ok) {
      throw new IntegrationApiError(
        `Slack ${method} failed: ${body?.error ?? res.status}`,
        res.status
      );
    }
    return body;
  }

  async postEphemeral(
    token: string,
    message: { channel: string; user: string; text: string; threadTs?: string | null }
  ): Promise<void> {
    await this.call(token, 'chat.postEphemeral', {
      body: {
        channel: message.channel,
        user: message.user,
        text: message.text,
        ...(message.threadTs ? { thread_ts: message.threadTs } : {})
      }
    });
  }

  async postMessage(
    token: string,
    message: { channel: string; text: string; threadTs?: string | null }
  ): Promise<{ ts: string | null; channel: string }> {
    const body = await this.call(token, 'chat.postMessage', {
      body: {
        channel: message.channel,
        text: message.text,
        unfurl_links: false,
        ...(message.threadTs ? { thread_ts: message.threadTs } : {})
      }
    });
    return {
      ts: typeof body.ts === 'string' ? body.ts : null,
      channel: typeof body.channel === 'string' ? body.channel : message.channel
    };
  }

  async respond(responseUrl: string, body: Record<string, unknown>): Promise<void> {
    await this.fetchImpl(responseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  }
}

export interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  url: string | null;
  labels: string[];
  state: string | null;
  updatedAt: string | null;
  isPullRequest: boolean;
  authorId: string | null;
}

export function toGithubIssue(raw: any): GithubIssue | null {
  if (!raw || typeof raw.title !== 'string' || !Number.isInteger(raw.number)) return null;
  return {
    number: raw.number,
    title: raw.title,
    body: typeof raw.body === 'string' ? raw.body : null,
    url: typeof raw.html_url === 'string' ? raw.html_url : null,
    labels: Array.isArray(raw.labels)
      ? raw.labels
          .map((l: any) => (typeof l === 'string' ? l : String(l?.name ?? '')))
          .filter(Boolean)
      : [],
    state: typeof raw.state === 'string' ? raw.state : null,
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : null,
    isPullRequest: !!raw.pull_request,
    authorId:
      raw.user?.id !== undefined && raw.user?.id !== null && raw.user?.type !== 'Bot'
        ? String(raw.user.id)
        : null
  };
}

export class GithubIssuesClient {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  private async request(
    token: string,
    path: string,
    init: { method?: string; body?: unknown } = {}
  ) {
    const res = await this.fetchImpl(`${GITHUB_API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'orchard-greenhouse',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    return { status: res.status, body: await readJson(res) };
  }

  async issue(token: string, owner: string, repo: string, number: number) {
    const res = await this.request(token, `/repos/${owner}/${repo}/issues/${number}`);
    return res.status === 200 ? toGithubIssue(res.body) : null;
  }

  async openIssues(token: string, owner: string, repo: string, q: string): Promise<GithubIssue[]> {
    const term = q.trim().slice(0, 200);
    if (term) {
      const query = `repo:${owner}/${repo} is:issue is:open ${term}`;
      const res = await this.request(
        token,
        `/search/issues?per_page=30&sort=updated&q=${encodeURIComponent(query)}`
      );
      if (res.status !== 200 || !Array.isArray(res.body?.items)) return [];
      return res.body.items
        .map(toGithubIssue)
        .filter((i: GithubIssue | null): i is GithubIssue => !!i && !i.isPullRequest);
    }
    const res = await this.request(
      token,
      `/repos/${owner}/${repo}/issues?state=open&per_page=30&sort=updated`
    );
    if (res.status !== 200 || !Array.isArray(res.body)) return [];
    return res.body
      .map(toGithubIssue)
      .filter((i: GithubIssue | null): i is GithubIssue => !!i && !i.isPullRequest);
  }

  async comment(token: string, owner: string, repo: string, number: number, body: string) {
    const res = await this.request(token, `/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: { body }
    });
    if (res.status !== 201) {
      throw new IntegrationApiError(`GitHub comment failed with ${res.status}`, res.status);
    }
  }
}
