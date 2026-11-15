import { guardedFetch } from '../notifications/webhook-guard';
import {
  GitProviderError,
  PROVIDER_UNREACHABLE,
  hostOf,
  isBitbucketEmail,
  type BranchRef,
  type CloneCredential,
  type ConnectionConfig,
  type GitProvider,
  type GitProviderKind,
  type PushEvent,
  type RepoRef,
  type WebhookHeaders,
  type WebhookRegistration
} from './git-provider';
import {
  parseBitbucketPush,
  parseGithubStylePush,
  parseGitlabPush,
  safeEqual,
  verifyHmacHeader
} from './parse-push';

const MAX_PAGES = 5;
const BITBUCKET_API_TOKEN_USER = 'x-bitbucket-api-token-auth';
const BITBUCKET_ACCESS_TOKEN_USER = 'x-token-auth';
const MAX_TREE_PAGES = 20;
const REQUEST_TIMEOUT_MS = 20_000;

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await guardedFetch(url, {
      ...init,
      label: 'Provider URL',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new GitProviderError(PROVIDER_UNREACHABLE);
  }
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await request(url, { headers: { Accept: 'application/json', ...headers } });
  if (!res.ok) throw new GitProviderError(PROVIDER_UNREACHABLE, res.status);
  return (await res.json()) as T;
}

async function postJson<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<T> {
  const res = await request(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new GitProviderError(PROVIDER_UNREACHABLE, res.status);
  return (await res.json().catch(() => ({}))) as T;
}

async function getText(url: string, headers: Record<string, string>): Promise<string | null> {
  const res = await request(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new GitProviderError(PROVIDER_UNREACHABLE, res.status);
  return res.text();
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

abstract class BaseProvider implements GitProvider {
  abstract readonly kind: GitProviderKind;
  readonly canList: boolean = true;

  constructor(protected readonly config: ConnectionConfig) {}

  protected get host(): string {
    return hostOf(this.config.baseUrl);
  }

  abstract listRepos(): Promise<RepoRef[]>;
  abstract listBranches(repo: string): Promise<BranchRef[]>;
  abstract defaultBranch(repo: string): Promise<string | null>;
  abstract listTree(repo: string, ref: string): Promise<string[] | null>;
  abstract readFile(repo: string, path: string, ref: string): Promise<string | null>;
  abstract cloneCredential(): CloneCredential;
  abstract verifyWebhook(rawBody: string, headers: WebhookHeaders): boolean;
  abstract parsePush(headers: WebhookHeaders, body: unknown): PushEvent | null;
  abstract ensureWebhook(repo: string, url: string, secret: string): Promise<WebhookRegistration>;
  abstract hasWebhook(repo: string, url: string): Promise<boolean | null>;
}

/** github.com with a token, or GitHub Enterprise Server. */
export class GithubTokenProvider extends BaseProvider {
  readonly kind = 'github' as const;

  private get api(): string {
    return this.host === 'github.com' ? 'https://api.github.com' : `${this.config.baseUrl}/api/v3`;
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.config.token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  async listRepos(): Promise<RepoRef[]> {
    const out: RepoRef[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await getJson<any[]>(
        `${this.api}/user/repos?per_page=100&sort=pushed&page=${page}`,
        this.headers
      );
      for (const r of rows) {
        out.push({
          id: String(r.id),
          fullName: r.full_name,
          url: r.html_url,
          defaultBranch: r.default_branch ?? null,
          private: Boolean(r.private)
        });
      }
      if (rows.length < 100) break;
    }
    return out;
  }

  async listBranches(repo: string): Promise<BranchRef[]> {
    const rows = await getJson<any[]>(
      `${this.api}/repos/${encodePath(repo)}/branches?per_page=100`,
      this.headers
    );
    return rows.map((b) => ({ name: b.name, sha: b.commit?.sha ?? null }));
  }

  async defaultBranch(repo: string): Promise<string | null> {
    const r = await getJson<any>(`${this.api}/repos/${encodePath(repo)}`, this.headers);
    return r.default_branch ?? null;
  }

  async listTree(repo: string, ref: string): Promise<string[] | null> {
    try {
      const t = await getJson<any>(
        `${this.api}/repos/${encodePath(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        this.headers
      );
      if (!Array.isArray(t.tree)) return null;
      return t.tree.filter((i: any) => i.type === 'blob').map((i: any) => String(i.path));
    } catch {
      return null;
    }
  }

  async readFile(repo: string, path: string, ref: string): Promise<string | null> {
    return getText(
      `${this.api}/repos/${encodePath(repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      { ...this.headers, Accept: 'application/vnd.github.raw+json' }
    );
  }

  cloneCredential(): CloneCredential {
    return { host: this.host, username: 'x-access-token', password: this.config.token };
  }

  verifyWebhook(rawBody: string, headers: WebhookHeaders): boolean {
    return verifyHmacHeader(
      headers,
      'x-hub-signature-256',
      rawBody,
      this.config.webhookSecret,
      'sha256='
    );
  }

  parsePush(headers: WebhookHeaders, body: unknown): PushEvent | null {
    if (headers['x-github-event'] && headers['x-github-event'] !== 'push') return null;
    return parseGithubStylePush(body);
  }

  async hasWebhook(repo: string, url: string): Promise<boolean | null> {
    try {
      const hooks = await getJson<any[]>(
        `${this.api}/repos/${encodePath(repo)}/hooks?per_page=100`,
        this.headers
      );
      return hooks.some((h) => h.config?.url === url);
    } catch {
      return null;
    }
  }

  async ensureWebhook(repo: string, url: string, secret: string): Promise<WebhookRegistration> {
    if (await this.hasWebhook(repo, url)) return 'exists';
    await postJson(`${this.api}/repos/${encodePath(repo)}/hooks`, this.headers, {
      name: 'web',
      active: true,
      events: ['push'],
      config: { url, content_type: 'json', secret, insecure_ssl: '0' }
    });
    return 'registered';
  }
}

export class GitlabProvider extends BaseProvider {
  readonly kind = 'gitlab' as const;

  private get api(): string {
    return `${this.config.baseUrl}/api/v4`;
  }

  private get headers() {
    return { Authorization: `Bearer ${this.config.token}` };
  }

  async listRepos(): Promise<RepoRef[]> {
    const out: RepoRef[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await getJson<any[]>(
        `${this.api}/projects?membership=true&simple=true&order_by=last_activity_at&per_page=100&page=${page}`,
        this.headers
      );
      for (const r of rows) {
        out.push({
          id: String(r.id),
          fullName: r.path_with_namespace,
          url: r.web_url,
          defaultBranch: r.default_branch ?? null,
          private: r.visibility !== 'public'
        });
      }
      if (rows.length < 100) break;
    }
    return out;
  }

  async listBranches(repo: string): Promise<BranchRef[]> {
    const rows = await getJson<any[]>(
      `${this.api}/projects/${encodeURIComponent(repo)}/repository/branches?per_page=100`,
      this.headers
    );
    return rows.map((b) => ({ name: b.name, sha: b.commit?.id ?? null }));
  }

  async defaultBranch(repo: string): Promise<string | null> {
    const r = await getJson<any>(`${this.api}/projects/${encodeURIComponent(repo)}`, this.headers);
    return r.default_branch ?? null;
  }

  async listTree(repo: string, ref: string): Promise<string[] | null> {
    const out: string[] = [];
    try {
      for (let page = 1; page <= MAX_TREE_PAGES; page++) {
        const rows = await getJson<any[]>(
          `${this.api}/projects/${encodeURIComponent(repo)}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(ref)}`,
          this.headers
        );
        for (const i of rows) if (i.type === 'blob') out.push(String(i.path));
        if (rows.length < 100) return out;
      }
      return null;
    } catch {
      return null;
    }
  }

  async readFile(repo: string, path: string, ref: string): Promise<string | null> {
    return getText(
      `${this.api}/projects/${encodeURIComponent(repo)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
      this.headers
    );
  }

  cloneCredential(): CloneCredential {
    return { host: this.host, username: 'oauth2', password: this.config.token };
  }

  verifyWebhook(rawBody: string, headers: WebhookHeaders): boolean {
    return safeEqual(headers['x-gitlab-token'], this.config.webhookSecret);
  }

  parsePush(headers: WebhookHeaders, body: unknown): PushEvent | null {
    const event = headers['x-gitlab-event'];
    if (event && event !== 'Push Hook') return null;
    return parseGitlabPush(body);
  }

  async hasWebhook(repo: string, url: string): Promise<boolean | null> {
    try {
      const hooks = await getJson<any[]>(
        `${this.api}/projects/${encodeURIComponent(repo)}/hooks?per_page=100`,
        this.headers
      );
      return hooks.some((h) => h.url === url);
    } catch {
      return null;
    }
  }

  async ensureWebhook(repo: string, url: string, secret: string): Promise<WebhookRegistration> {
    if (await this.hasWebhook(repo, url)) return 'exists';
    await postJson(`${this.api}/projects/${encodeURIComponent(repo)}/hooks`, this.headers, {
      url,
      token: secret,
      push_events: true,
      enable_ssl_verification: true
    });
    return 'registered';
  }
}

/** Gitea, Forgejo and Codeberg share the API. */
export class GiteaProvider extends BaseProvider {
  readonly kind = 'gitea' as const;

  private get api(): string {
    return `${this.config.baseUrl}/api/v1`;
  }

  private get headers() {
    return { Authorization: `token ${this.config.token}` };
  }

  async listRepos(): Promise<RepoRef[]> {
    const out: RepoRef[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await getJson<any[]>(
        `${this.api}/user/repos?limit=50&page=${page}`,
        this.headers
      );
      for (const r of rows) {
        out.push({
          id: String(r.id),
          fullName: r.full_name,
          url: r.html_url,
          defaultBranch: r.default_branch ?? null,
          private: Boolean(r.private)
        });
      }
      if (rows.length < 50) break;
    }
    return out;
  }

  async listBranches(repo: string): Promise<BranchRef[]> {
    const rows = await getJson<any[]>(
      `${this.api}/repos/${encodePath(repo)}/branches?limit=100`,
      this.headers
    );
    return rows.map((b) => ({ name: b.name, sha: b.commit?.id ?? null }));
  }

  async defaultBranch(repo: string): Promise<string | null> {
    const r = await getJson<any>(`${this.api}/repos/${encodePath(repo)}`, this.headers);
    return r.default_branch ?? null;
  }

  async listTree(repo: string, ref: string): Promise<string[] | null> {
    const out: string[] = [];
    try {
      for (let page = 1; page <= MAX_TREE_PAGES; page++) {
        const t = await getJson<any>(
          `${this.api}/repos/${encodePath(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=true&per_page=1000&page=${page}`,
          this.headers
        );
        if (!Array.isArray(t.tree)) return null;
        for (const i of t.tree) if (i.type === 'blob') out.push(String(i.path));
        if (!t.truncated || t.tree.length === 0) return out;
      }
      return null;
    } catch {
      return null;
    }
  }

  async readFile(repo: string, path: string, ref: string): Promise<string | null> {
    return getText(
      `${this.api}/repos/${encodePath(repo)}/raw/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
      this.headers
    );
  }

  cloneCredential(): CloneCredential {
    return {
      host: this.host,
      username: this.config.username || 'git',
      password: this.config.token
    };
  }

  verifyWebhook(rawBody: string, headers: WebhookHeaders): boolean {
    return (
      verifyHmacHeader(headers, 'x-gitea-signature', rawBody, this.config.webhookSecret) ||
      verifyHmacHeader(headers, 'x-forgejo-signature', rawBody, this.config.webhookSecret) ||
      verifyHmacHeader(headers, 'x-gogs-signature', rawBody, this.config.webhookSecret)
    );
  }

  parsePush(headers: WebhookHeaders, body: unknown): PushEvent | null {
    const event = headers['x-gitea-event'] ?? headers['x-forgejo-event'] ?? headers['x-gogs-event'];
    if (event && event !== 'push') return null;
    return parseGithubStylePush(body);
  }

  async hasWebhook(repo: string, url: string): Promise<boolean | null> {
    try {
      const hooks = await getJson<any[]>(
        `${this.api}/repos/${encodePath(repo)}/hooks?limit=100`,
        this.headers
      );
      return hooks.some((h) => h.config?.url === url);
    } catch {
      return null;
    }
  }

  async ensureWebhook(repo: string, url: string, secret: string): Promise<WebhookRegistration> {
    if (await this.hasWebhook(repo, url)) return 'exists';
    await postJson(`${this.api}/repos/${encodePath(repo)}/hooks`, this.headers, {
      type: 'gitea',
      active: true,
      events: ['push'],
      config: { url, content_type: 'json', secret }
    });
    return 'registered';
  }
}

/** Bitbucket Cloud with an API token, an OAuth token, or an access token. */
export class BitbucketProvider extends BaseProvider {
  readonly kind = 'bitbucket' as const;

  private get api(): string {
    return 'https://api.bitbucket.org/2.0';
  }

  private get email(): string | null {
    return isBitbucketEmail(this.config.username) ? this.config.username : null;
  }

  private get headers() {
    if (this.email) {
      const pair = Buffer.from(`${this.email}:${this.config.token}`).toString('base64');
      return { Authorization: `Basic ${pair}` };
    }
    return { Authorization: `Bearer ${this.config.token}` };
  }

  async listRepos(): Promise<RepoRef[]> {
    const out: RepoRef[] = [];
    let url: string | null = `${this.api}/repositories?role=member&pagelen=100&sort=-updated_on`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const data: any = await getJson<any>(url, this.headers);
      for (const r of data.values ?? []) {
        out.push({
          id: String(r.uuid),
          fullName: r.full_name,
          url: r.links?.html?.href ?? `https://bitbucket.org/${r.full_name}`,
          defaultBranch: r.mainbranch?.name ?? null,
          private: Boolean(r.is_private)
        });
      }
      url = data.next ?? null;
    }
    return out;
  }

  async listBranches(repo: string): Promise<BranchRef[]> {
    const data = await getJson<any>(
      `${this.api}/repositories/${encodePath(repo)}/refs/branches?pagelen=100`,
      this.headers
    );
    return (data.values ?? []).map((b: any) => ({ name: b.name, sha: b.target?.hash ?? null }));
  }

  async defaultBranch(repo: string): Promise<string | null> {
    const r = await getJson<any>(`${this.api}/repositories/${encodePath(repo)}`, this.headers);
    return r.mainbranch?.name ?? null;
  }

  async listTree(repo: string, ref: string): Promise<string[] | null> {
    const out: string[] = [];
    let url: string | null =
      `${this.api}/repositories/${encodePath(repo)}/src/${encodeURIComponent(ref)}/?max_depth=6&pagelen=100&q=type%3D%22commit_file%22`;
    try {
      for (let page = 0; url && page < MAX_TREE_PAGES; page++) {
        const data: any = await getJson<any>(url, this.headers);
        for (const f of data.values ?? []) if (f.type === 'commit_file') out.push(String(f.path));
        url = data.next ?? null;
      }
      return url ? null : out;
    } catch {
      return null;
    }
  }

  async readFile(repo: string, path: string, ref: string): Promise<string | null> {
    return getText(
      `${this.api}/repositories/${encodePath(repo)}/src/${encodeURIComponent(ref)}/${encodePath(path)}`,
      this.headers
    );
  }

  cloneCredential(): CloneCredential {
    return {
      host: this.host,
      username: this.email ? BITBUCKET_API_TOKEN_USER : BITBUCKET_ACCESS_TOKEN_USER,
      password: this.config.token
    };
  }

  verifyWebhook(rawBody: string, headers: WebhookHeaders): boolean {
    return verifyHmacHeader(
      headers,
      'x-hub-signature',
      rawBody,
      this.config.webhookSecret,
      'sha256='
    );
  }

  parsePush(headers: WebhookHeaders, body: unknown): PushEvent | null {
    const event = headers['x-event-key'];
    if (event && event !== 'repo:push') return null;
    return parseBitbucketPush(body);
  }

  async hasWebhook(repo: string, url: string): Promise<boolean | null> {
    try {
      const data = await getJson<any>(
        `${this.api}/repositories/${encodePath(repo)}/hooks?pagelen=100`,
        this.headers
      );
      return (data.values ?? []).some((h: any) => h.url === url);
    } catch {
      return null;
    }
  }

  async ensureWebhook(repo: string, url: string, secret: string): Promise<WebhookRegistration> {
    if (await this.hasWebhook(repo, url)) return 'exists';
    await postJson(`${this.api}/repositories/${encodePath(repo)}/hooks`, this.headers, {
      description: 'Orchard auto-deploy',
      url,
      active: true,
      secret,
      events: ['repo:push']
    });
    return 'registered';
  }
}

/** Any https git host with a username and token. No listing; pastes only. */
export class GenericProvider extends BaseProvider {
  readonly kind = 'generic' as const;
  override readonly canList = false;

  async listRepos(): Promise<RepoRef[]> {
    return [];
  }

  async listBranches(): Promise<BranchRef[]> {
    return [];
  }

  async defaultBranch(): Promise<string | null> {
    return null;
  }

  async listTree(): Promise<string[] | null> {
    return null;
  }

  async readFile(): Promise<string | null> {
    return null;
  }

  cloneCredential(): CloneCredential {
    return {
      host: this.host,
      username: this.config.username || 'git',
      password: this.config.token
    };
  }

  verifyWebhook(rawBody: string, headers: WebhookHeaders): boolean {
    return (
      verifyHmacHeader(
        headers,
        'x-hub-signature-256',
        rawBody,
        this.config.webhookSecret,
        'sha256='
      ) ||
      verifyHmacHeader(headers, 'x-gitea-signature', rawBody, this.config.webhookSecret) ||
      safeEqual(headers['x-gitlab-token'], this.config.webhookSecret)
    );
  }

  parsePush(_headers: WebhookHeaders, body: unknown): PushEvent | null {
    return parseGithubStylePush(body) ?? parseGitlabPush(body) ?? parseBitbucketPush(body);
  }

  async hasWebhook(): Promise<boolean | null> {
    return null;
  }

  async ensureWebhook(): Promise<WebhookRegistration> {
    return 'unsupported';
  }
}

export function providerFor(config: ConnectionConfig): GitProvider {
  switch (config.kind) {
    case 'github':
      return new GithubTokenProvider(config);
    case 'gitlab':
      return new GitlabProvider(config);
    case 'gitea':
      return new GiteaProvider(config);
    case 'bitbucket':
      return new BitbucketProvider(config);
    default:
      return new GenericProvider(config);
  }
}
