export type GitProviderKind = 'github' | 'gitlab' | 'gitea' | 'bitbucket' | 'generic';

export const GIT_PROVIDER_KINDS: readonly GitProviderKind[] = [
  'github',
  'gitlab',
  'gitea',
  'bitbucket',
  'generic'
];

export const PROVIDER_DEFAULT_BASE_URL: Record<GitProviderKind, string | null> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
  gitea: 'https://codeberg.org',
  bitbucket: 'https://bitbucket.org',
  generic: null
};

export interface RepoRef {
  id: string;
  fullName: string;
  url: string;
  defaultBranch: string | null;
  private: boolean;
}

export interface BranchRef {
  name: string;
  sha: string | null;
}

export interface CloneCredential {
  host: string;
  username: string;
  password: string;
}

export interface PushEvent {
  repoFullName: string;
  repoUrl: string;
  externalRepoId: string | null;
  branch: string;
  commitSha: string | null;
  beforeSha: string | null;
  message: string;
  authorName: string | null;
  authorUsername: string | null;
  changedFiles: string[] | null;
  deleted: boolean;
}

export interface WebhookHeaders {
  [name: string]: string | undefined;
}

export interface ConnectionConfig {
  kind: GitProviderKind;
  baseUrl: string;
  username: string | null;
  token: string;
  webhookSecret: string;
}

/**
 * One forge. The read side (repos, branches, tree, file) feeds the repo
 * picker and framework detection through the same `FileReader` the GitHub
 * path uses. The push side is pure: verify with the connection's secret,
 * then adapt the payload to one shape.
 */
export interface GitProvider {
  readonly kind: GitProviderKind;
  readonly canList: boolean;
  listRepos(): Promise<RepoRef[]>;
  listBranches(repo: string): Promise<BranchRef[]>;
  defaultBranch(repo: string): Promise<string | null>;
  listTree(repo: string, ref: string): Promise<string[] | null>;
  readFile(repo: string, path: string, ref: string): Promise<string | null>;
  cloneCredential(): CloneCredential;
  verifyWebhook(rawBody: string, headers: WebhookHeaders): boolean;
  parsePush(headers: WebhookHeaders, body: unknown): PushEvent | null;
  /** Register a push hook at `url` on the repo, or find the one already there. */
  ensureWebhook(repo: string, url: string, secret: string): Promise<WebhookRegistration>;
  hasWebhook(repo: string, url: string): Promise<boolean | null>;
}

export type WebhookRegistration = 'registered' | 'exists' | 'unsupported';

export class GitProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'GitProviderError';
  }
}

export function normalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `https://${url.host}${path}`;
}

export function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}

export function branchFromRef(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  if (!ref.startsWith('refs/heads/')) return null;
  const branch = ref.slice('refs/heads/'.length);
  return branch || null;
}

export function repoUrlVariantsFor(url: string): string[] {
  const clean = url.replace(/\.git$/, '').replace(/\/+$/, '');
  return [clean, `${clean}.git`];
}
