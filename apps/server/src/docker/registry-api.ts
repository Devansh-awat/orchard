import { createHash } from 'crypto';
import { bearerTokenUrl, parseBearerChallenge } from '../projects/registry-credentials';
import { plainHttpHostsFrom } from '../projects/image-ports';

export const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json'
].join(', ');

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TAG_PAGES = 100;

export type RegistryFailure = 'denied' | 'unsupported' | 'failed';

export class RegistryError extends Error {
  constructor(
    readonly kind: RegistryFailure,
    readonly status: number | null,
    message: string
  ) {
    super(message);
  }
}

export interface RegistryEndpoint {
  baseUrl: string;
  username?: string;
  password?: string;
  fetch?: typeof fetch;
}

function nextPage(link: string | null): string | null {
  const match = link?.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
  return match ? match[1] : null;
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

export class RegistryApi {
  private readonly tokens = new Map<string, string>();

  private readonly fetchFn: typeof fetch;

  constructor(private readonly endpoint: RegistryEndpoint) {
    this.fetchFn = endpoint.fetch ?? fetch;
  }

  get user(): string | null {
    return this.endpoint.username || null;
  }

  async listTags(repository: string): Promise<string[]> {
    const tags: string[] = [];
    let path: string | null = `/v2/${repository}/tags/list?n=1000`;
    for (let page = 0; path && page < MAX_TAG_PAGES; page++) {
      const res = await this.request('GET', path, repository);
      if (res.status === 404) {
        await discard(res);
        return tags;
      }
      if (!res.ok) throw await this.failure(res, `list tags of ${repository}`);
      const body = (await res.json()) as { tags?: string[] | null };
      tags.push(...(body.tags ?? []));
      path = nextPage(res.headers.get('link'));
    }
    return tags;
  }

  async digestOf(repository: string, tag: string): Promise<string | null> {
    const path = `/v2/${repository}/manifests/${encodeURIComponent(tag)}`;
    const head = await this.request('HEAD', path, repository, { accept: MANIFEST_ACCEPT });
    await discard(head);
    if (head.status === 404) return null;
    const digest = head.headers.get('docker-content-digest');
    if (head.ok && digest) return digest;
    if (!head.ok && head.status !== 405) {
      throw await this.failure(head, `resolve ${repository}:${tag}`);
    }
    const res = await this.request('GET', path, repository, { accept: MANIFEST_ACCEPT });
    if (res.status === 404) {
      await discard(res);
      return null;
    }
    if (!res.ok) throw await this.failure(res, `resolve ${repository}:${tag}`);
    const body = Buffer.from(await res.arrayBuffer());
    return (
      res.headers.get('docker-content-digest') ??
      `sha256:${createHash('sha256').update(body).digest('hex')}`
    );
  }

  async deleteManifest(repository: string, digest: string): Promise<boolean> {
    const res = await this.request('DELETE', `/v2/${repository}/manifests/${digest}`, repository);
    await discard(res);
    if (res.ok) return true;
    if (res.status === 404) return false;
    throw await this.failure(res, `delete ${repository}@${digest}`);
  }

  async deleteTag(repository: string, tag: string): Promise<boolean> {
    const path = `/v2/${repository}/manifests/${encodeURIComponent(tag)}`;
    const res = await this.request('DELETE', path, repository);
    await discard(res);
    if (res.ok) return true;
    if (res.status === 404) return false;
    throw await this.failure(res, `untag ${repository}:${tag}`);
  }

  private basic(): string | null {
    const { username, password } = this.endpoint;
    if (!username || !password) return null;
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  private send(
    method: string,
    url: URL,
    authorization: string | null,
    headers: Record<string, string>
  ): Promise<Response> {
    return this.fetchFn(url, {
      method,
      headers: authorization ? { ...headers, authorization } : headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  }

  private async request(
    method: string,
    path: string,
    repository: string,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    const url = new URL(path, this.endpoint.baseUrl);
    const cached = this.tokens.get(repository);
    const res = await this.send(method, url, cached ?? this.basic(), headers);
    if (res.status !== 401) return res;
    const challenge = parseBearerChallenge(res.headers.get('www-authenticate'));
    if (!challenge) return res;
    await discard(res);
    const token = await this.token(challenge.realm, challenge.service, repository);
    if (!token) return this.send(method, url, this.basic(), headers);
    this.tokens.set(repository, token);
    return this.send(method, url, token, headers);
  }

  private async token(
    realm: string,
    service: string | undefined,
    repository: string
  ): Promise<string | null> {
    const url = bearerTokenUrl({
      realm,
      service,
      scope: `repository:${repository}:pull,push,delete`
    });
    const res = await this.send('GET', new URL(url), this.basic(), { accept: 'application/json' });
    if (!res.ok) {
      await discard(res);
      return null;
    }
    const body = (await res.json().catch(() => ({}))) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    return token ? `Bearer ${token}` : null;
  }

  private async failure(res: Response, action: string): Promise<RegistryError> {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const kind: RegistryFailure =
      res.status === 401 || res.status === 403
        ? 'denied'
        : res.status === 400 || res.status === 405
          ? 'unsupported'
          : 'failed';
    return new RegistryError(kind, res.status, `${action}: HTTP ${res.status} ${detail}`.trim());
  }
}

export function platformRegistryApi(env: NodeJS.ProcessEnv = process.env): RegistryApi | null {
  const host = (env.DOCKER_REGISTRY_PUSH || env.DOCKER_REGISTRY_PULL || '').trim();
  if (!host) return null;
  const bare = host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const plain = plainHttpHostsFrom(env.REGISTRY_HTTP_HOSTS);
  const key = /:\d+$/.test(bare) ? bare.toLowerCase() : `${bare.toLowerCase()}:80`;
  const scheme = host.startsWith('http://') || plain.has(key) ? 'http' : 'https';
  return new RegistryApi({
    baseUrl: `${scheme}://${bare}`,
    username: env.HARBOR_USERNAME || undefined,
    password: env.HARBOR_PASSWORD || undefined
  });
}
