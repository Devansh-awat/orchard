import {
  Injectable,
  BadRequestException,
  ConflictException,
  OnModuleDestroy,
  OnModuleInit,
  Optional
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SharedCache } from '../cache/shared-cache.service';
import {
  personalCredentialsRefused,
  personalSourceSelectionRefused
} from '../auth/request-context';
import { OAuthService } from '../auth/oauth.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { canonicalRepoUrl, isNullSha, repoUrlVariants } from './auto-deploy-match';
import { changedFilesFromCompare } from './watch-paths';
import { submoduleRepos } from './submodules';
import { GithubAppConfigService } from './github-app-config.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { parseDockerfileEnvVars } from './dockerfile-env';
import {
  REPO_SEARCH_LIMIT,
  RepoSearchError,
  buildSearchQ,
  classifyGitHubFailure,
  mergeExact,
  normalizeRepoQuery,
  ownedBy,
  pickSearchInstallation,
  rankRepos,
  retryAfterSeconds,
  toSearchedRepo,
  type SearchedRepo
} from './repo-search';
import {
  detectApps,
  primaryApp,
  type DetectedApp,
  type WorkspaceInfo,
  type RepoBuildConfig,
  type FileReader
} from './framework-detect';

/** What the create form and the CLI get back from a detection run. */
import { SCORE_FILES, parseScore, summarize, type ScoreSummary } from '../score/score-parse';
import { finalBaseImage, inspectImagePorts } from '../projects/image-ports';
import { hasDotPathSegment } from '../docker/repo-url';

export interface RepoConfigDetection {
  buildType: 'dockerfile' | 'railpack';
  dockerfilePath: string | null;
  dockerfiles: string[];
  stages: string[];
  ports: number[];
  env: { key: string; value: string }[];
  framework: string | null;
  suggestedName: string;
  apps: DetectedApp[];
  workspace: WorkspaceInfo;
  repoConfig: RepoBuildConfig | null;
  rootDirectory: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
  score: ScoreSummary | null;
}

/** Long enough to cover the create form's repeated detects, short enough that a
 *  push shows up on the next visit. */
const DETECT_CACHE_TTL_MS = 60_000;
const DETECT_CACHE_MAX = 200;

// How often the leader looks for deployments that still have no repository id.
// Converges to a no-op after the first pass or two, then costs one indexed
// query per interval.
const REPO_LINK_INTERVAL_MS = 10 * 60 * 1000;

// Deployments examined per reconcile pass, and how many of them may cost a
// GitHub API call. Only repos that were renamed before their id was recorded
// need the call, so this is a small tail.
const REPO_LINK_SCAN = 500;
const REPO_LINK_API_BUDGET = 25;

// A webhook delivery has ten seconds to answer, and this call sits in front of
// the builds it decides on, so it gets a slice of that rather than all of it.
const COMPARE_TIMEOUT_MS = 5_000;

export interface GitHubUser {
  id: string;
  login: string;
  avatar_url: string;
  name: string;
  email: string;
}

export interface GitHubWebhookPayload {
  action?: string;
  ref?: string;
  before?: string;
  after?: string;
  repository?: {
    id: number;
    name: string;
    full_name: string;
    owner: {
      login: string;
    };
  };
  sender?: {
    login: string;
    id: number;
  };
  head_commit?: {
    id: string;
    message: string;
    author: {
      name: string;
      email: string;
    };
  };
}

export interface GitHubDeploymentResponse {
  id: number;
  sha: string;
  ref: string;
  environment: string;
  created_at: string;
  statuses_url: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  default_branch: string;
  clone_url?: string;
  html_url?: string;
}

export interface GitHubBranch {
  name: string;
  commit: {
    sha: string;
    url: string;
  };
  default?: boolean;
}

export interface GitHubContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string;
  type: string;
}

interface CachedRepos {
  repos: GitHubRepo[];
  timestamp: number;
}

const MAX_SUBMODULE_DEPTH = 5;

const MAX_SUBMODULE_CHECKS = 25;

@Injectable()
export class GitHubService implements OnModuleInit, OnModuleDestroy {
  private repoLinkTimer?: ReturnType<typeof setInterval>;

  private reconcilingRepoLinks = false;

  private get clientId(): string {
    return this.appConfig.get().clientId;
  }

  private get clientSecret(): string {
    return this.appConfig.get().clientSecret;
  }

  getOAuthClientId(): string | null {
    return this.appConfig.get().clientId;
  }

  private issueCommentHandler:
    | ((deliveryId: string | undefined, body: unknown) => Promise<Record<string, unknown>>)
    | null = null;

  setIssueCommentHandler(
    handler:
      | ((deliveryId: string | undefined, body: unknown) => Promise<Record<string, unknown>>)
      | null
  ): void {
    this.issueCommentHandler = handler;
  }

  async handleIssueCommentEvent(
    deliveryId: string | undefined,
    body: unknown
  ): Promise<Record<string, unknown>> {
    if (!this.issueCommentHandler) {
      return { received: true, action: 'ignored', reason: "issue comments aren't handled" };
    }
    return this.issueCommentHandler(deliveryId, body);
  }

  private readonly repoCache = new Map<string, CachedRepos>();

  private readonly CACHE_TTL = 5 * 60 * 1000;

  private readonly cache: SharedCache;

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauthService: OAuthService,
    private readonly appConfig: GithubAppConfigService,
    private readonly leader: LeaderElectionService,
    private readonly crypto: SecretCryptoService,
    @Optional() cache?: SharedCache
  ) {
    this.cache = cache ?? new SharedCache();
  }

  onModuleInit() {
    // Leadership lands asynchronously, so the interval alone would miss the
    // first pass on a fresh replica.
    this.leader.onAcquired(() => {
      void this.runRepoLinkReconcile();
    });
    this.repoLinkTimer = setInterval(() => {
      void this.runRepoLinkReconcile();
    }, REPO_LINK_INTERVAL_MS);
    this.repoLinkTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.repoLinkTimer) clearInterval(this.repoLinkTimer);
    this.repoLinkTimer = undefined;
  }

  private getCacheKey(accessToken: string, maxPages: number): string {
    return `${crypto.createHash('sha256').update(accessToken).digest('hex')}_${maxPages}`;
  }

  private getCachedRepos(accessToken: string, maxPages: number): GitHubRepo[] | null {
    const key = this.getCacheKey(accessToken, maxPages);
    const cached = this.repoCache.get(key);

    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.repos;
    }

    if (cached) {
      this.repoCache.delete(key);
    }

    return null;
  }

  private setCachedRepos(accessToken: string, maxPages: number, repos: GitHubRepo[]): void {
    const key = this.getCacheKey(accessToken, maxPages);
    this.repoCache.set(key, {
      repos,
      timestamp: Date.now()
    });
  }

  async verifySessionToken(token: string) {
    return this.oauthService.verifySessionToken(token);
  }

  async exchangeCodeForToken(code: string): Promise<{
    accessToken: string;
    expiresAt: Date | null;
    refreshToken: string | null;
    refreshTokenExpiresAt: Date | null;
  }> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code
    });

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: params.toString()
    });

    if (!response.ok) {
      const error = await response.text();
      throw new BadRequestException(`Failed to exchange code for token: ${error}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new BadRequestException(`GitHub OAuth error: ${data.error_description || data.error}`);
    }

    return this.parseTokenResponse(data);
  }

  private parseTokenResponse(data: any): {
    accessToken: string;
    expiresAt: Date | null;
    refreshToken: string | null;
    refreshTokenExpiresAt: Date | null;
  } {
    const now = Date.now();
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : null;
    const refreshExpiresIn =
      typeof data.refresh_token_expires_in === 'number' ? data.refresh_token_expires_in : null;
    return {
      accessToken: data.access_token,
      expiresAt: expiresIn ? new Date(now + expiresIn * 1000) : null,
      refreshToken: data.refresh_token ?? null,
      refreshTokenExpiresAt: refreshExpiresIn ? new Date(now + refreshExpiresIn * 1000) : null
    };
  }

  // Refresh a user's GitHub access token using the stored refresh token.
  // Returns the new access token, or null if refresh failed (user must reauthorize).
  private readonly userTokenRefreshes = new Map<string, Promise<string | null>>();

  refreshUserToken(userId: string): Promise<string | null> {
    const pending = this.userTokenRefreshes.get(userId);
    if (pending) return pending;
    const run = this.refreshUserTokenOnce(userId).finally(() =>
      this.userTokenRefreshes.delete(userId)
    );
    this.userTokenRefreshes.set(userId, run);
    return run;
  }

  private async refreshUserTokenOnce(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { githubRefreshToken: true, githubRefreshTokenExpiresAt: true }
    });
    if (!user?.githubRefreshToken) return null;
    if (
      user.githubRefreshTokenExpiresAt &&
      user.githubRefreshTokenExpiresAt.getTime() <= Date.now()
    ) {
      return null;
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: this.crypto.open(user.githubRefreshToken)
    });

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: params.toString()
    });

    if (!response.ok) {
      console.warn(`[GitHub] Refresh token exchange failed for user ${userId}: ${response.status}`);
      await this.clearGitHubTokens(userId);
      return null;
    }

    const data = await response.json();
    if (data.error || !data.access_token) {
      console.warn(`[GitHub] Refresh token error for user ${userId}:`, data.error);
      await this.clearGitHubTokens(userId);
      return null;
    }

    const parsed = this.parseTokenResponse(data);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        githubAccessToken: this.crypto.seal(parsed.accessToken),
        githubTokenExpiresAt: parsed.expiresAt,
        // GitHub rotates the refresh token on each use: only overwrite if returned.
        ...(parsed.refreshToken
          ? {
              githubRefreshToken: this.crypto.seal(parsed.refreshToken),
              githubRefreshTokenExpiresAt: parsed.refreshTokenExpiresAt
            }
          : {})
      }
    });
    return parsed.accessToken;
  }

  // Return a usable access token for the user, refreshing if expired/near-expiry.
  // Returns null if no token, refresh failed, or refresh token also expired.
  async getValidUserToken(userId: string): Promise<string | null> {
    if (personalCredentialsRefused()) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { githubAccessToken: true, githubTokenExpiresAt: true, githubRefreshToken: true }
    });
    if (!user?.githubAccessToken) return null;

    // Non-expiring token (app config has "Expire user authorization tokens" off).
    if (!user.githubTokenExpiresAt) return this.crypto.open(user.githubAccessToken);

    // Refresh if within 2 minutes of expiry.
    const bufferMs = 2 * 60 * 1000;
    if (user.githubTokenExpiresAt.getTime() - bufferMs > Date.now()) {
      return this.crypto.open(user.githubAccessToken);
    }

    if (!user.githubRefreshToken) return null;
    return this.refreshUserToken(userId);
  }

  private async clearGitHubTokens(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        githubAccessToken: null,
        githubTokenExpiresAt: null,
        githubRefreshToken: null,
        githubRefreshTokenExpiresAt: null
      }
    });
  }

  async getGitHubUser(accessToken: string): Promise<GitHubUser> {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    if (!response.ok) {
      throw new BadRequestException('Failed to fetch GitHub user info');
    }

    return await response.json();
  }

  async linkGitHubAccount(userId: string, code: string): Promise<void> {
    const tokens = await this.exchangeCodeForToken(code);
    const githubUser = await this.getGitHubUser(tokens.accessToken);

    const existing = await this.prisma.user.findUnique({
      where: { githubId: String(githubUser.id) },
      select: { id: true }
    });
    if (existing && existing.id !== userId) {
      throw new ConflictException(
        `This GitHub account (@${githubUser.login}) is already linked to another Orchard account. Disconnect it there first, then try again.`
      );
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        githubId: String(githubUser.id),
        githubUsername: githubUser.login,
        githubAccessToken: this.crypto.seal(tokens.accessToken),
        githubTokenExpiresAt: tokens.expiresAt,
        githubRefreshToken: this.crypto.seal(tokens.refreshToken),
        githubRefreshTokenExpiresAt: tokens.refreshTokenExpiresAt
      }
    });
    await this.forgetUserGitHub(userId);
  }

  async unlinkGitHubAccount(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        githubId: null,
        githubUsername: null,
        githubAccessToken: null,
        githubTokenExpiresAt: null,
        githubRefreshToken: null,
        githubRefreshTokenExpiresAt: null
      }
    });
    await this.forgetUserGitHub(userId);
  }

  async getUserRepositories(accessToken: string, maxPages = 3): Promise<GitHubRepo[]> {
    const cached = this.getCachedRepos(accessToken, maxPages);
    if (cached) {
      return cached;
    }

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    const fetchPage = async (page: number): Promise<GitHubRepo[]> => {
      const response = await fetch(
        `https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
        { headers }
      );

      if (!response.ok) {
        throw new BadRequestException('Failed to fetch GitHub repositories');
      }

      return await response.json();
    };

    const firstPage = await fetchPage(1);

    if (firstPage.length < 100 || maxPages <= 1) {
      this.setCachedRepos(accessToken, maxPages, firstPage);
      return firstPage;
    }

    const remainingPages = await Promise.allSettled(
      Array.from({ length: Math.min(maxPages - 1, 9) }, (_, i) => fetchPage(i + 2))
    );

    const allRepos = [
      firstPage,
      ...remainingPages
        .filter(
          (result): result is PromiseFulfilledResult<GitHubRepo[]> => result.status === 'fulfilled'
        )
        .map((result) => result.value)
    ].flat();

    this.setCachedRepos(accessToken, maxPages, allRepos);
    return allRepos;
  }

  private githubApiHeaders(accessToken?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }
    return headers;
  }

  async getRepoBranches(accessToken: string, owner: string, repo: string): Promise<GitHubBranch[]> {
    const MAX_PAGES = 10;
    const fetchPage = async (page: number): Promise<GitHubBranch[]> => {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100&page=${page}`,
        {
          headers: this.githubApiHeaders(accessToken)
        }
      );
      if (!response.ok) throw new BadRequestException('Failed to fetch repository branches');
      return response.json();
    };

    // Probe page 1 first; if it's full, fan out the rest in parallel.
    const first = await fetchPage(1);
    if (first.length < 100) return first;
    const rest = await Promise.all(
      Array.from({ length: MAX_PAGES - 1 }, (_, i) => fetchPage(i + 2))
    );
    const all = [first];
    for (const page of rest) {
      if (page.length === 0) break;
      all.push(page);
    }
    return all.flat();
  }

  /**
   * Encode a repo-relative path for a contents URL.
   *
   * `fetch` resolves dot segments before the request goes out, so an unencoded
   * `..` escapes the owner/repo the caller was authorized against and reaches
   * anything else the token covers, including `/installation/repositories`.
   * Traversal is rejected and every surviving segment is encoded.
   */
  private static encodeRepoPath(path: string): string {
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.some((s) => s === '.' || s === '..' || s.includes('\\'))) {
      throw new BadRequestException('Invalid file path');
    }
    return segments.map((s) => encodeURIComponent(s)).join('/');
  }

  async getRepoContents(
    accessToken: string,
    owner: string,
    repo: string,
    path = '',
    branch?: string
  ): Promise<GitHubContent[]> {
    let url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${GitHubService.encodeRepoPath(path)}`;

    if (branch) {
      url += `?ref=${encodeURIComponent(branch)}`;
    }

    const response = await fetch(url, {
      headers: this.githubApiHeaders(accessToken)
    });

    if (!response.ok) {
      throw new BadRequestException('Failed to fetch repository contents');
    }

    return await response.json();
  }

  /**
   * Flat list of every blob path in the repo from one recursive Git Trees call.
   * Returns null when the tree is unavailable (bad ref, or truncated because
   * the repo exceeds GitHub's tree limit) so callers can fall back rather than
   * silently detect against a partial repo.
   */
  async getRepoTree(
    accessToken: string,
    owner: string,
    repo: string,
    branch?: string
  ): Promise<string[] | null> {
    const ref = branch || 'HEAD';
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;

    try {
      const response = await fetch(url, {
        headers: this.githubApiHeaders(accessToken)
      });
      if (!response.ok) return null;

      const tree = await response.json();
      if (!Array.isArray(tree?.tree)) return null;

      return tree.tree
        .filter((item: any) => item.type === 'blob')
        .map((item: any) => String(item.path));
    } catch (error) {
      console.error('Git tree API failed:', error.message);
      return null;
    }
  }

  async findDockerfiles(
    accessToken: string,
    owner: string,
    repo: string,
    branch?: string
  ): Promise<string[]> {
    const paths = await this.getRepoTree(accessToken, owner, repo, branch);
    if (!paths) {
      // Fallback to root-only scan if tree API fails
      return this.findDockerfilesFallback(accessToken, owner, repo, branch);
    }
    return this.dockerfilesFromTree(paths);
  }

  private dockerfilesFromTree(paths: string[]): string[] {
    return paths.filter((p) => {
      if (p.includes('node_modules/') || p.includes('.git/')) return false;
      const fileName = p.split('/').pop()?.toLowerCase() ?? '';
      return fileName === 'dockerfile' || fileName.startsWith('dockerfile.');
    });
  }

  private async findDockerfilesFallback(
    accessToken: string,
    owner: string,
    repo: string,
    branch?: string
  ): Promise<string[]> {
    try {
      const contents = await this.getRepoContents(accessToken, owner, repo, '', branch);
      return contents
        .filter((item) => {
          if (item.type !== 'file') return false;
          const name = item.name.toLowerCase();
          return name === 'dockerfile' || name.startsWith('dockerfile.');
        })
        .map((item) => item.path);
    } catch {
      return [];
    }
  }

  async getFileContent(
    accessToken: string,
    owner: string,
    repo: string,
    path: string,
    branch?: string
  ): Promise<string> {
    let url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${GitHubService.encodeRepoPath(path)}`;

    if (branch) {
      url += `?ref=${encodeURIComponent(branch)}`;
    }

    const headers = this.githubApiHeaders(accessToken);
    headers['Accept'] = 'application/vnd.github.raw+json';
    const response = await fetch(url, { headers });

    if (response.status === 404) {
      throw new BadRequestException(
        `${path} isn't in ${owner}/${repo}${branch ? ` on ${branch}` : ''}. Check the path and branch.`
      );
    }
    if (!response.ok) {
      throw new BadRequestException(`GitHub wouldn't return ${path} (HTTP ${response.status}).`);
    }

    return await response.text();
  }

  parseExposedPort(dockerfileContent: string): number | null {
    const lines = dockerfileContent.split('\n');
    let lastExposedPort: number | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.toUpperCase().startsWith('EXPOSE')) {
        const match = trimmed.match(/EXPOSE\s+(\d+)/i);
        if (match) {
          lastExposedPort = parseInt(match[1], 10);
        }
      }
    }

    return lastExposedPort;
  }

  parseExposedPorts(dockerfileContent: string): number[] {
    const ports: number[] = [];
    const lines = dockerfileContent.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.toUpperCase().startsWith('EXPOSE')) {
        // EXPOSE can have multiple ports: EXPOSE 80 443 8080/tcp
        const portMatches = trimmed.matchAll(/(\d+)(?:\/\w+)?/g);
        for (const m of portMatches) {
          const port = parseInt(m[1], 10);
          if (port > 0 && !ports.includes(port)) {
            ports.push(port);
          }
        }
      }
    }

    return ports;
  }

  async detectPorts(dockerfileContent: string): Promise<number[]> {
    const exposed = this.parseExposedPorts(dockerfileContent);
    if (exposed.length > 0) return exposed;
    const base = finalBaseImage(dockerfileContent);
    if (!base) return [];
    const inherited = await inspectImagePorts(base);
    return inherited.port ? [inherited.port] : [];
  }

  parseEnvVars(dockerfileContent: string): { key: string; value: string }[] {
    return parseDockerfileEnvVars(dockerfileContent);
  }

  async getDockerfileInfo(
    accessToken: string,
    owner: string,
    repo: string,
    dockerfilePath: string,
    branch?: string
  ): Promise<{
    exposedPorts: number[];
    envVars: { key: string; value: string }[];
    stages: string[];
  }> {
    const content = await this.getFileContent(accessToken, owner, repo, dockerfilePath, branch);
    return {
      exposedPorts: await this.detectPorts(content),
      envVars: this.parseEnvVars(content),
      stages: this.parseDockerfileStages(content)
    };
  }

  async getDefaultBranch(accessToken: string | null, owner: string, repo: string): Promise<string> {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        {
          headers: this.githubApiHeaders(accessToken ?? '')
        }
      );
      if (response.ok) {
        const data = await response.json();
        if (data?.default_branch) return String(data.default_branch);
      }
    } catch {
      // fall through to the conventional default
    }
    return 'main';
  }

  /**
   * One-shot build-config detection for the zero-config create flow.
   *
   * Prefers a Dockerfile (with EXPOSE/ENV/stage parsing); otherwise mirrors
   * Railpack's provider rules to describe every deployable app in the repo, so
   * a monorepo can offer a root-directory picker instead of failing to build.
   * Every field is a suggestion the caller can override, and the real answer is
   * reconciled from railpack-info.json once the first build runs.
   *
   * The create form re-detects whenever the repo or branch changes, so results
   * are memoised briefly. The key includes the caller's token: two users with
   * different access to the same repo must never share an answer. In-flight
   * promises are cached too, which collapses the duplicate request the form
   * fires when the branch list confirms the default branch. A null token reads
   * the repo anonymously, which is all a public repo needs.
   */
  async detectRepoConfig(
    token: string | null,
    owner: string,
    repo: string,
    branch?: string
  ): Promise<RepoConfigDetection> {
    const accessToken = token ?? '';
    const key = [
      crypto.createHash('sha256').update(accessToken).digest('hex').slice(0, 16),
      owner,
      repo,
      branch ?? ''
    ].join(' ');

    const now = Date.now();
    const hit = this.detectCache.get(key);
    if (hit && now - hit.at < DETECT_CACHE_TTL_MS) return hit.value;

    const value = this.computeRepoConfig(accessToken, owner, repo, branch);
    this.detectCache.set(key, { at: now, value });
    // A failure must not be remembered, or the next attempt returns the same
    // rejection from cache instead of retrying.
    value.catch(() => this.detectCache.delete(key));

    if (this.detectCache.size > DETECT_CACHE_MAX) {
      for (const [k, entry] of this.detectCache) {
        if (now - entry.at >= DETECT_CACHE_TTL_MS) this.detectCache.delete(k);
      }
      while (this.detectCache.size > DETECT_CACHE_MAX) {
        this.detectCache.delete(this.detectCache.keys().next().value);
      }
    }

    return value;
  }

  private readonly detectCache = new Map<
    string,
    { at: number; value: Promise<RepoConfigDetection> }
  >();

  /**
   * One cache per detection run: several presets read the same package.json,
   * and a missing file is a legitimate (cached) answer, not an error.
   */
  private repoFileReader(
    accessToken: string,
    owner: string,
    repo: string,
    branch?: string
  ): FileReader {
    const fileCache = new Map<string, Promise<string | null>>();
    return (path) => {
      if (!fileCache.has(path)) {
        fileCache.set(
          path,
          this.getFileContent(accessToken, owner, repo, path, branch).catch(() => null)
        );
      }
      return fileCache.get(path)!;
    };
  }

  /**
   * Describe the deployable apps in a repo, skipping the Dockerfile
   * short-circuit that detectRepoConfig applies.
   *
   * detectRepoConfig answers "how should the create form be filled in", so a
   * repo containing a Dockerfile stops right there: there is nothing left to
   * suggest. This answers "what is this app", which a Railpack deployment still
   * needs even when the repo also happens to carry a Dockerfile it is not
   * building from. Those two questions look the same until a repo adds a
   * Dockerfile it never wired up, which is common enough to matter.
   */
  async detectRepoApps(
    accessToken: string,
    owner: string,
    repo: string,
    branch?: string
  ): Promise<DetectedApp[]> {
    const tree = await this.getRepoTree(accessToken, owner, repo, branch).catch(() => null);
    if (!tree) return [];

    const { apps } = await detectApps(tree, this.repoFileReader(accessToken, owner, repo, branch));
    return apps;
  }

  private async computeRepoConfig(
    accessToken: string,
    owner: string,
    repo: string,
    branch?: string
  ): Promise<RepoConfigDetection> {
    const suggestedName = repo
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);

    const tree = await this.getRepoTree(accessToken, owner, repo, branch).catch(() => null);
    const dockerfiles = tree
      ? this.dockerfilesFromTree(tree)
      : await this.findDockerfiles(accessToken, owner, repo, branch).catch(() => [] as string[]);

    const read = this.repoFileReader(accessToken, owner, repo, branch);
    let score: ScoreSummary | null = null;
    for (const file of SCORE_FILES) {
      if (tree && !tree.includes(file)) continue;
      const plan = parseScore(await read(file));
      if (plan) {
        score = summarize(file, plan);
        break;
      }
    }

    const empty = {
      apps: [] as DetectedApp[],
      workspace: { isWorkspace: false, packageManager: 'npm' } as WorkspaceInfo,
      repoConfig: null,
      rootDirectory: null,
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      score
    };

    if (dockerfiles.length > 0) {
      const dockerfilePath = [...dockerfiles].sort(
        (a, b) => a.split('/').length - b.split('/').length || a.length - b.length
      )[0];
      const info = await this.getDockerfileInfo(
        accessToken,
        owner,
        repo,
        dockerfilePath,
        branch
      ).catch(() => null);
      return {
        buildType: 'dockerfile',
        dockerfilePath,
        dockerfiles,
        stages: info?.stages ?? [],
        ports: info?.exposedPorts ?? [],
        env: info?.envVars ?? [],
        framework: null,
        suggestedName,
        ...empty
      };
    }

    if (!tree) {
      // Tree unavailable (bad ref, or a repo past GitHub's tree limit). Rather
      // than detect against a partial view, hand back a bare Railpack build and
      // let its own detection do the work at build time.
      return {
        buildType: 'railpack',
        dockerfilePath: null,
        dockerfiles: [],
        stages: [],
        ports: [3000],
        env: [{ key: 'PORT', value: '3000' }],
        framework: null,
        suggestedName,
        ...empty
      };
    }

    const { apps, workspace, repoConfig } = await detectApps(
      tree,
      this.repoFileReader(accessToken, owner, repo, branch)
    );
    // An orchard.json naming a directory picks the app; otherwise the usual
    // "recognised root app, else shallowest" rule applies.
    const primary =
      (repoConfig?.rootDirectory && apps.find((a) => a.dir === repoConfig.rootDirectory)) ||
      primaryApp(apps);

    return {
      buildType: 'railpack',
      dockerfilePath: null,
      dockerfiles: [],
      stages: [],
      ports: [primary?.port ?? 3000],
      env: [{ key: 'PORT', value: String(primary?.port ?? 3000) }],
      framework: primary?.framework ?? null,
      suggestedName,
      apps,
      workspace,
      repoConfig,
      rootDirectory: primary?.dir || null,
      installCommand: primary?.installCommand ?? null,
      buildCommand: primary?.buildCommand ?? null,
      startCommand: primary?.startCommand ?? null,
      outputDirectory: primary?.outputDirectory ?? null,
      score
    };
  }

  parseDockerfileStages(dockerfileContent: string): string[] {
    const stages: string[] = [];
    const lines = dockerfileContent.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('FROM')) {
        const asMatch = trimmed.match(/AS\s+([^\s#]+)/i);
        if (asMatch) {
          const stageName = asMatch[1].trim();
          if (stageName && !stages.includes(stageName)) {
            stages.push(stageName);
          }
        }
      }
    }

    return stages;
  }

  async getDockerfileStages(
    accessToken: string,
    owner: string,
    repo: string,
    dockerfilePath: string,
    branch?: string
  ): Promise<string[]> {
    const content = await this.getFileContent(accessToken, owner, repo, dockerfilePath, branch);
    return this.parseDockerfileStages(content);
  }

  verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
    if (!signature || !secret) {
      return false;
    }

    const expectedSignature = `sha256=${crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex')}`;

    try {
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
    } catch {
      return false;
    }
  }

  generateWebhookSecret(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  async createWebhook(
    accessToken: string,
    owner: string,
    repo: string,
    webhookUrl: string,
    secret: string
  ): Promise<{ id: number; active: boolean }> {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'web',
          active: true,
          events: ['push'],
          config: {
            url: webhookUrl,
            content_type: 'json',
            secret,
            insecure_ssl: '0'
          }
        })
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new BadRequestException(`Failed to create webhook: ${error}`);
    }

    return await response.json();
  }

  async deleteWebhook(
    accessToken: string,
    owner: string,
    repo: string,
    webhookId: string
  ): Promise<void> {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${webhookId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );

    if (!response.ok && response.status !== 404) {
      const error = await response.text();
      throw new BadRequestException(`Failed to delete webhook: ${error}`);
    }
  }

  // Create a GitHub Deployment (shows in GitHub UI)
  async createGitHubDeployment(
    accessToken: string,
    owner: string,
    repo: string,
    ref: string,
    environment = 'production',
    description?: string
  ): Promise<GitHubDeploymentResponse> {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/deployments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ref,
          environment,
          description: description || `Deploying ${ref} to ${environment}`,
          auto_merge: false,
          required_contexts: [] // Skip status checks for now
        })
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new BadRequestException(`Failed to create GitHub deployment: ${error}`);
    }

    return await response.json();
  }

  // Update GitHub Deployment status (shows status on commits/PRs)
  async updateDeploymentStatus(
    accessToken: string,
    owner: string,
    repo: string,
    deploymentId: number,
    state: 'pending' | 'in_progress' | 'success' | 'failure' | 'error',
    options?: {
      logUrl?: string;
      environmentUrl?: string;
      description?: string;
    }
  ): Promise<void> {
    const body: Record<string, unknown> = {
      state,
      auto_inactive: true
    };

    if (options?.logUrl) {
      body.log_url = options.logUrl;
    }
    if (options?.environmentUrl) {
      body.environment_url = options.environmentUrl;
    }
    if (options?.description) {
      body.description = options.description;
    }

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/deployments/${deploymentId}/statuses`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`Failed to update deployment status: ${error}`);
      // Don't throw - status update failures shouldn't block the build
    }
  }

  // Get commit SHA for a ref (branch or tag)
  async getCommitSha(
    accessToken: string,
    owner: string,
    repo: string,
    ref: string
  ): Promise<string> {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );

    if (!response.ok) {
      throw new BadRequestException('Failed to get commit SHA');
    }

    const data = await response.json();
    return data.sha;
  }

  parseRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
    // Handle various GitHub URL formats
    // https://github.com/owner/repo
    // https://github.com/owner/repo.git
    // git@github.com:owner/repo.git
    if (hasDotPathSegment(repoUrl)) return null;
    const httpsMatch = repoUrl.match(/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:[/\s]|$)/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }

    const sshMatch = repoUrl.match(/github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }

    return null;
  }

  private generateAppJwt(): string {
    const { appId, privateKey } = this.appConfig.get();

    if (!appId || !privateKey) {
      throw new BadRequestException(
        'GitHub App not configured. Create one in Instance admin, or set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.'
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 60, // Issued 60 seconds ago to account for clock drift
      exp: now + 600, // Expires in 10 minutes (max allowed)
      iss: appId
    };

    // Create JWT manually using crypto (RS256)
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signatureInput = `${header}.${payloadB64}`;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signatureInput);
    const signature = sign.sign(privateKey, 'base64url');

    return `${signatureInput}.${signature}`;
  }

  async getInstallationAccessToken(
    installationId: bigint,
    cloneRepos?: string[]
  ): Promise<{ token: string; expiresAt: Date }> {
    const jwt = this.generateAppJwt();

    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        ...(cloneRepos
          ? {
              body: JSON.stringify({
                repositories: cloneRepos,
                permissions: { contents: 'read' }
              })
            }
          : {})
      }
    );

    if (!response.ok) {
      const error = await response.text();
      if (response.status === 404) {
        await this.prisma.gitHubAppInstallation
          .updateMany({
            where: { installationId, suspendedAt: null },
            data: { suspendedAt: new Date() }
          })
          .catch(() => {});
      }
      throw new BadRequestException(`Failed to get installation access token: ${error}`);
    }

    const data = await response.json();
    return {
      token: data.token,
      expiresAt: new Date(data.expires_at)
    };
  }

  async getOrRefreshInstallationToken(installationId: bigint): Promise<string> {
    const installation = await this.prisma.gitHubAppInstallation.findUnique({
      where: { installationId }
    });

    if (installation?.accessToken && installation.tokenExpiresAt) {
      const bufferTime = 5 * 60 * 1000;
      if (new Date(installation.tokenExpiresAt).getTime() - bufferTime > Date.now()) {
        return installation.accessToken;
      }
    }

    const { token, expiresAt } = await this.getInstallationAccessToken(installationId);

    if (installation) {
      await this.prisma.gitHubAppInstallation.update({
        where: { installationId },
        data: {
          accessToken: token,
          tokenExpiresAt: expiresAt
        }
      });
    }

    return token;
  }

  async handleInstallationEvent(
    action: string,
    installation: {
      id: number;
      account: {
        login: string;
        id: number;
        type: string;
      };
      repository_selection: string;
    },
    sender: { login: string; id: number }
  ): Promise<void> {
    console.log(
      `[GitHub App] Installation ${action} by ${sender.login} for ${installation.account.login}`
    );

    if (action === 'created') {
      const user = await this.prisma.user.findFirst({
        where: { githubId: String(sender.id) }
      });

      if (!user) {
        console.warn(
          `[GitHub App] No Orchard user for GitHub ID ${sender.id} (${sender.login}): creating installation without user link`
        );
      }

      await this.prisma.gitHubAppInstallation.upsert({
        where: { installationId: BigInt(installation.id) },
        create: {
          userId: user?.id ?? null,
          installationId: BigInt(installation.id),
          accountLogin: installation.account.login,
          accountId: BigInt(installation.account.id),
          accountType: installation.account.type,
          repositorySelection: installation.repository_selection
        },
        update: {
          ...(user ? { userId: user.id } : {}),
          accountLogin: installation.account.login,
          accountId: BigInt(installation.account.id),
          accountType: installation.account.type,
          repositorySelection: installation.repository_selection,
          suspendedAt: null
        }
      });

      console.log(
        `[GitHub App] Installation created for ${installation.account.login}${user ? ` (linked to ${user.username})` : ' (no user link)'}`
      );
    } else if (action === 'deleted') {
      await this.prisma.gitHubAppInstallation.deleteMany({
        where: { installationId: BigInt(installation.id) }
      });

      console.log(`[GitHub App] Installation deleted`);
    } else if (action === 'suspend') {
      await this.prisma.gitHubAppInstallation.updateMany({
        where: { installationId: BigInt(installation.id) },
        data: { suspendedAt: new Date() }
      });

      console.log(`[GitHub App] Installation suspended`);
    } else if (action === 'unsuspend') {
      await this.prisma.gitHubAppInstallation.updateMany({
        where: { installationId: BigInt(installation.id) },
        data: { suspendedAt: null }
      });

      console.log(`[GitHub App] Installation unsuspended`);
    }
  }

  async getInstallationRepositories(installationId: bigint): Promise<GitHubRepo[]> {
    const token = await this.getOrRefreshInstallationToken(installationId);

    const repos: GitHubRepo[] = [];
    let page = 1;
    const perPage = 100;

    while (page <= 10) {
      // Max 10 pages
      const response = await fetch(
        `https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          }
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new BadRequestException(`Failed to get installation repositories: ${error}`);
      }

      const data = await response.json();
      repos.push(...data.repositories);

      if (data.repositories.length < perPage) {
        break;
      }
      page++;
    }

    return repos;
  }

  async isRepoAccessibleByInstallation(
    installationId: bigint,
    owner: string,
    repo: string
  ): Promise<boolean> {
    const token = await this.getOrRefreshInstallationToken(installationId);

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );

    return response.ok;
  }

  getAppWebhookSecret(): string {
    const secret = this.appConfig.get().webhookSecret;
    if (!secret) {
      throw new BadRequestException('GitHub App webhook secret not configured');
    }
    return secret;
  }

  verifyAppWebhookSignature(payload: string, signature: string): boolean {
    const secret = this.getAppWebhookSecret();
    return this.verifyWebhookSignature(payload, signature, secret);
  }

  async findInstallationForRepo(
    owner: string,
    repo: string
  ): Promise<{ installationId: bigint } | null> {
    // Find installations that might have access to this repo
    const installations = await this.prisma.gitHubAppInstallation.findMany({
      where: {
        accountLogin: { equals: owner, mode: 'insensitive' },
        suspendedAt: null
      }
    });
    for (const installation of installations) {
      try {
        const hasAccess = await this.isRepoAccessibleByInstallation(
          installation.installationId,
          owner,
          repo
        );
        if (hasAccess) {
          return { installationId: installation.installationId };
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(
          `[GitHub App] Failed to check repo access for installation ${installation.installationId}: ${reason}`
        );
      }
    }

    // Fallback: query GitHub directly, then backfill the DB so future
    // lookups are fast and token caching works.
    try {
      const jwt = this.generateAppJwt();
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
        {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          }
        }
      );
      if (response.ok) {
        const data = await response.json();
        const installationId = BigInt(data.id);

        // Backfill DB: non-blocking so the return isn't gated on it
        this.prisma.gitHubAppInstallation
          .upsert({
            where: { installationId },
            create: {
              userId: null,
              installationId,
              accountLogin: data.account?.login ?? owner,
              accountId: BigInt(data.account?.id ?? 0),
              accountType: data.account?.type ?? 'Organization',
              repositorySelection: data.repository_selection ?? 'all'
            },
            update: {
              accountLogin: data.account?.login ?? owner,
              accountType: data.account?.type ?? 'Organization',
              repositorySelection: data.repository_selection ?? 'all',
              suspendedAt: null
            }
          })
          .then(() => {
            console.log(
              `[GitHub App] Backfilled installation ${installationId} for ${owner}/${repo} from GitHub API.`
            );
          })
          .catch((e) => {
            console.warn(`[GitHub App] Failed to backfill installation ${installationId}:`, e);
          });

        return { installationId };
      }
    } catch (e) {
      console.warn(`[GitHub App] GitHub API fallback failed for ${owner}/${repo}:`, e);
    }

    return null;
  }

  async createGitHubDeploymentWithApp(
    installationId: bigint,
    owner: string,
    repo: string,
    ref: string,
    environment = 'production',
    description?: string
  ): Promise<GitHubDeploymentResponse> {
    const token = await this.getOrRefreshInstallationToken(installationId);
    return this.createGitHubDeployment(token, owner, repo, ref, environment, description);
  }

  async updateDeploymentStatusWithApp(
    installationId: bigint,
    owner: string,
    repo: string,
    deploymentId: number,
    state: 'pending' | 'in_progress' | 'success' | 'failure' | 'error',
    options?: {
      logUrl?: string;
      environmentUrl?: string;
      description?: string;
    }
  ): Promise<void> {
    const token = await this.getOrRefreshInstallationToken(installationId);
    return this.updateDeploymentStatus(token, owner, repo, deploymentId, state, options);
  }

  // Check if a repo is public using an unauthenticated GitHub API call.
  async isRepoPublic(owner: string, repo: string): Promise<boolean> {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          }
        }
      );
      if (!response.ok) return false;
      const data = await response.json();
      return data.visibility === 'public' || data.private === false;
    } catch {
      return false;
    }
  }

  // Verify that a specific user (by stored OAuth token) can access a given repo on GitHub.
  // Uses the user-to-server token: GitHub returns 200 only if the user can see the repo.
  // Returns false if no token, repo not found, or any non-OK response.
  async verifyUserCanAccessRepo(userId: string, owner: string, repo: string): Promise<boolean> {
    if (personalSourceSelectionRefused()) return false;
    const token = await this.getValidUserToken(userId);
    if (!token) return false;

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );
    return response.ok;
  }

  async userMaintainsRepo(userId: string, owner: string, repo: string): Promise<boolean> {
    if (personalSourceSelectionRefused()) return false;
    const token = await this.getValidUserToken(userId);
    if (!token) return false;
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );
    if (!response.ok) return false;
    const data = await response.json();
    return data.private === true || data.permissions?.push === true;
  }

  // Full repo set visible to an installation token, paginated in parallel via
  // the Link header. Used only to (re)seed the mirror table.
  private async listInstallationRepos(installationToken: string): Promise<any[]> {
    const perPage = 100;
    const maxPages = 30;

    const fetchPage = async (page: number): Promise<{ repos: any[]; lastPage: number | null }> => {
      const response = await fetch(
        `https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`,
        {
          signal: AbortSignal.timeout(8000),
          headers: {
            Authorization: `Bearer ${installationToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          }
        }
      );
      if (!response.ok) {
        if (response.status === 404) return { repos: [], lastPage: null };
        throw new BadRequestException(
          `Failed to list installation repos: ${await response.text()}`
        );
      }
      const link = response.headers.get('link') || '';
      const lastMatch = link.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
      const data = await response.json();
      return {
        repos: data.repositories || [],
        lastPage: lastMatch ? Number(lastMatch[1]) : null
      };
    };

    const first = await fetchPage(1);
    if (!first.lastPage || first.lastPage <= 1) return first.repos;

    const lastPage = Math.min(first.lastPage, maxPages);
    if (first.lastPage > maxPages) {
      console.warn(
        `[GitHub] installation has more than ${maxPages * perPage} repos, mirror truncated`
      );
    }
    const rest = await Promise.all(
      Array.from({ length: lastPage - 1 }, (_, i) => fetchPage(i + 2))
    );
    return [first, ...rest].flatMap((r) => r.repos);
  }

  private readonly mirrorSyncInflight = new Set<string>();

  /**
   * Repo ids the user can actually see through one installation.
   *
   * The mirror table is installation-scoped, so it contains every repo the App
   * was granted, including ones an org member has no permission on. GitHub's
   * user-to-server `/user/installations/{id}/repositories` returns the
   * intersection of the installation grant and the caller's own access, which
   * is what we have to list against. Returns null when we could not determine
   * the set, so callers can fail closed rather than fall back to the mirror.
   */
  private async getUserAccessibleRepoIds(
    userToken: string,
    installationId: bigint
  ): Promise<Set<string> | null> {
    const perPage = 100;
    const maxPages = 30;

    const fetchPage = async (page: number): Promise<{ ids: string[]; lastPage: number | null }> => {
      const response = await fetch(
        `https://api.github.com/user/installations/${installationId}/repositories?per_page=${perPage}&page=${page}`,
        {
          signal: AbortSignal.timeout(8000),
          headers: {
            Authorization: `Bearer ${userToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          }
        }
      );
      if (!response.ok) {
        throw new Error(`/user/installations/${installationId}/repositories -> ${response.status}`);
      }
      const link = response.headers.get('link') || '';
      const lastMatch = link.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
      const data = await response.json();
      return {
        ids: (data.repositories || []).map((r: any) => String(r.id)),
        lastPage: lastMatch ? Number(lastMatch[1]) : null
      };
    };

    try {
      const first = await fetchPage(1);
      if (!first.lastPage || first.lastPage <= 1) return new Set(first.ids);

      const lastPage = Math.min(first.lastPage, maxPages);
      if (first.lastPage > maxPages) {
        console.warn(
          `[GitHub] user-accessible repo list for installation ${installationId} truncated at ${maxPages * perPage}`
        );
      }
      const rest = await Promise.all(
        Array.from({ length: lastPage - 1 }, (_, i) => fetchPage(i + 2))
      );
      return new Set([first, ...rest].flatMap((r) => r.ids));
    } catch (e: any) {
      console.warn(
        `[GitHub] couldn't resolve user-accessible repos for installation ${installationId}:`,
        e?.message ?? e
      );
      return null;
    }
  }

  async syncInstallationRepos(appInstallation: {
    id: string;
    installationId: bigint;
  }): Promise<void> {
    if (this.mirrorSyncInflight.has(appInstallation.id)) return;
    this.mirrorSyncInflight.add(appInstallation.id);
    try {
      const token = await this.getOrRefreshInstallationToken(appInstallation.installationId);
      const repos = await this.listInstallationRepos(token);
      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.gitHubRepoMirror.deleteMany({
          where: { appInstallationId: appInstallation.id }
        }),
        this.prisma.gitHubRepoMirror.createMany({
          data: repos.map((r) => ({
            appInstallationId: appInstallation.id,
            githubRepoId: BigInt(r.id),
            fullName: r.full_name,
            private: Boolean(r.private),
            defaultBranch: r.default_branch ?? null,
            pushedAt: r.pushed_at ? new Date(r.pushed_at) : null,
            syncedAt: now
          })),
          skipDuplicates: true
        })
      ]);
      console.log(
        `[GitHub] mirrored ${repos.length} repos for installation ${appInstallation.installationId}`
      );
    } finally {
      this.mirrorSyncInflight.delete(appInstallation.id);
    }
  }

  async syncInstallationReposById(installationId: bigint): Promise<void> {
    const inst = await this.prisma.gitHubAppInstallation.findUnique({ where: { installationId } });
    if (!inst) return;
    await this.syncInstallationRepos(inst);
  }

  async applyInstallationReposEvent(
    installationId: bigint,
    added: any[],
    removed: any[]
  ): Promise<void> {
    const inst = await this.prisma.gitHubAppInstallation.findUnique({ where: { installationId } });
    if (!inst) return;
    if (removed.length > 0) {
      await this.prisma.gitHubRepoMirror.deleteMany({
        where: {
          appInstallationId: inst.id,
          githubRepoId: { in: removed.map((r) => BigInt(r.id)) }
        }
      });
    }
    for (const r of added) {
      await this.prisma.gitHubRepoMirror.upsert({
        where: {
          appInstallationId_githubRepoId: { appInstallationId: inst.id, githubRepoId: BigInt(r.id) }
        },
        update: { fullName: r.full_name, private: Boolean(r.private), syncedAt: new Date() },
        create: {
          appInstallationId: inst.id,
          githubRepoId: BigInt(r.id),
          fullName: r.full_name,
          private: Boolean(r.private),
          pushedAt: new Date()
        }
      });
    }
  }

  /**
   * The deployments a push should fire, matched on the repository's numeric id
   * first and its URL second.
   *
   * The id is the only part of a repository that a rename does not change.
   * Matching on the URL alone meant renaming a repo on GitHub silently
   * detached every deployment built from it: the webhook arrives under the new
   * full name, the lookup matches nothing, and the push is ignored without
   * anything being raised anywhere. Rows are still required to belong to the
   * sending installation, so a full name alone can never impersonate a repo.
   */
  async findAutoDeployTargets(installationId: bigint, repoId: bigint | null, repoFullName: string) {
    const byUrl = { githubRepo: { in: repoUrlVariants(repoFullName) } };
    const rows = await this.prisma.deployment.findMany({
      where: {
        githubInstallationId: installationId,
        autoDeployEnabled: true,
        ...(repoId == null
          ? byUrl
          : { OR: [{ ...byUrl, githubRepoId: null }, { githubRepoId: repoId }] })
      },
      include: {
        project: {
          include: {
            organization: true
          }
        }
      }
    });
    if (repoId != null) await this.adoptRepoIdentity(rows, repoId, repoFullName);
    return rows;
  }

  /**
   * Record the id and current URL on rows we just matched. Every push is a
   * free, authenticated statement of what this repository is now called, so
   * matching by URL once is enough to never have to again.
   */
  private async adoptRepoIdentity(
    rows: { id: string; githubRepo: string | null; githubRepoId: bigint | null }[],
    repoId: bigint,
    repoFullName: string
  ): Promise<void> {
    for (const row of rows) {
      const url = canonicalRepoUrl(row.githubRepo, repoFullName);
      const data: { githubRepoId?: bigint; githubRepo?: string } = {};
      if (row.githubRepoId !== repoId) data.githubRepoId = repoId;
      if (row.githubRepo !== url) data.githubRepo = url;
      if (Object.keys(data).length === 0) continue;
      await this.prisma.deployment
        .update({ where: { id: row.id }, data })
        .catch((e) =>
          console.warn(`[GitHub] adopting repo identity for ${row.id} failed:`, e?.message ?? e)
        );
    }
  }

  /**
   * The files a push actually changed, straight from GitHub, or null when it
   * cannot say.
   *
   * The push payload carries file lists of its own and they are almost always
   * complete, but "almost always" is not something a path filter can be built
   * on: GitHub caps the commit array at 2048 and documents nothing at all about
   * the per-commit file lists. A deployment that skips builds based on which
   * paths changed deserves an answer that is either authoritative or admits it
   * is not, and null here means the caller deploys rather than guesses.
   */
  async compareChangedFiles(
    installationId: bigint,
    repoFullName: string,
    base: string | null | undefined,
    head: string | null | undefined
  ): Promise<string[] | null> {
    // A branch's first push has no base to compare against.
    if (isNullSha(base) || isNullSha(head)) return null;
    try {
      const token = await this.getOrRefreshInstallationToken(installationId);
      const response = await fetch(
        `https://api.github.com/repos/${repoFullName}/compare/${base}...${head}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json'
          },
          signal: AbortSignal.timeout(COMPARE_TIMEOUT_MS)
        }
      );
      if (!response.ok) {
        console.warn(
          `[GitHub] compare ${repoFullName} ${base}...${head} returned ${response.status}`
        );
        return null;
      }
      return changedFilesFromCompare(await response.json());
    } catch (e: any) {
      console.warn(`[GitHub] compare ${repoFullName} failed:`, e?.message ?? e);
      return null;
    }
  }

  async applyRepositoryEvent(
    installationId: bigint,
    action: string,
    repo: any,
    previousFullName?: string | null
  ): Promise<void> {
    if (!repo?.id) return;
    const inst = await this.prisma.gitHubAppInstallation.findUnique({ where: { installationId } });
    if (!inst) return;
    const githubRepoId = BigInt(repo.id);
    if (action === 'deleted' || action === 'transferred') {
      await this.prisma.gitHubRepoMirror.deleteMany({
        where: { appInstallationId: inst.id, githubRepoId }
      });
      return;
    }
    await this.prisma.gitHubRepoMirror.updateMany({
      where: { appInstallationId: inst.id, githubRepoId },
      data: {
        fullName: repo.full_name,
        private: Boolean(repo.private),
        defaultBranch: repo.default_branch ?? null,
        syncedAt: new Date()
      }
    });
    if (repo.full_name) {
      await this.applyRepoRename(installationId, githubRepoId, repo.full_name, previousFullName);
    }
  }

  /**
   * Follow a rename through to everything that stores the repository URL. Rows
   * that already carry the id are found by it; rows that predate the id are
   * found by the name GitHub tells us they used to have.
   */
  private async applyRepoRename(
    installationId: bigint,
    repoId: bigint,
    fullName: string,
    previousFullName?: string | null
  ): Promise<void> {
    const oldUrls = previousFullName ? repoUrlVariants(previousFullName) : [];
    const rows = await this.prisma.deployment.findMany({
      where: {
        githubInstallationId: installationId,
        OR: [{ githubRepoId: repoId }, ...(oldUrls.length ? [{ githubRepo: { in: oldUrls } }] : [])]
      },
      select: { id: true, githubRepo: true, githubRepoId: true }
    });
    await this.adoptRepoIdentity(rows, repoId, fullName);

    // Compose stacks only read their file through the URL, which GitHub keeps
    // redirecting, so this is about the repo the UI shows you rather than
    // anything that would break. They carry no id column to match on.
    if (oldUrls.length === 0) return;
    const stacks = await this.prisma.composeStack.findMany({
      where: { githubInstallationId: installationId, githubRepo: { in: oldUrls } },
      select: { id: true, githubRepo: true }
    });
    for (const stack of stacks) {
      await this.prisma.composeStack
        .update({
          where: { id: stack.id },
          data: { githubRepo: canonicalRepoUrl(stack.githubRepo, fullName) }
        })
        .catch(() => {});
    }
    if (rows.length > 0 || stacks.length > 0) {
      console.log(
        `[GitHub] ${previousFullName} -> ${fullName}: relinked ${rows.length} deployment(s), ${stacks.length} compose stack(s)`
      );
    }
  }

  private async runRepoLinkReconcile(): Promise<void> {
    if (!this.leader.isLeader() || this.reconcilingRepoLinks) return;
    this.reconcilingRepoLinks = true;
    try {
      const linked = await this.reconcileRepoLinks();
      if (linked > 0) console.log(`[GitHub] recorded the repository id on ${linked} deployment(s)`);
    } catch (e: any) {
      console.warn('[GitHub] repo link reconcile failed:', e?.message ?? e);
    } finally {
      this.reconcilingRepoLinks = false;
    }
  }

  /**
   * Give every GitHub-linked deployment its repository id.
   *
   * Rows whose stored name is still the repo's real name are resolved from the
   * installation mirror for free. The ones left over are exactly the rows whose
   * repository was renamed while nothing was watching, so they are asked about
   * directly: GET /repos follows a rename and answers with the current name
   * and the id, which is the only way to reattach a deployment that has already
   * drifted.
   */
  async reconcileRepoLinks(): Promise<number> {
    const rows = await this.prisma.deployment.findMany({
      where: {
        githubRepoId: null,
        githubInstallationId: { not: null },
        githubRepo: { not: null }
      },
      select: { id: true, githubRepo: true, githubInstallationId: true },
      take: REPO_LINK_SCAN
    });
    if (rows.length === 0) return 0;

    // Group by installation and repo name: one lookup serves every deployment
    // built from the same repo.
    const groups = new Map<
      string,
      { installationId: bigint; fullName: string; rows: typeof rows }
    >();
    for (const row of rows) {
      const parsed = this.parseRepoUrl(row.githubRepo!);
      if (!parsed || !row.githubInstallationId) continue;
      const fullName = `${parsed.owner}/${parsed.repo}`;
      const key = `${row.githubInstallationId}/${fullName}`;
      const group = groups.get(key);
      if (group) group.rows.push(row);
      else groups.set(key, { installationId: row.githubInstallationId, fullName, rows: [row] });
    }
    if (groups.size === 0) return 0;

    const installs = await this.prisma.gitHubAppInstallation.findMany({
      where: {
        installationId: { in: [...new Set([...groups.values()].map((g) => g.installationId))] }
      },
      select: { id: true, installationId: true }
    });
    const instByInstallationId = new Map(installs.map((i) => [i.installationId.toString(), i.id]));
    const mirrored = await this.prisma.gitHubRepoMirror.findMany({
      where: {
        appInstallationId: { in: installs.map((i) => i.id) },
        fullName: { in: [...new Set([...groups.values()].map((g) => g.fullName))] }
      },
      select: { appInstallationId: true, githubRepoId: true, fullName: true }
    });
    const mirrorIndex = new Map(
      mirrored.map((m) => [`${m.appInstallationId}/${m.fullName}`, m.githubRepoId])
    );

    let linked = 0;
    let apiCalls = 0;
    for (const group of groups.values()) {
      const instId = instByInstallationId.get(group.installationId.toString());
      const fromMirror = instId ? mirrorIndex.get(`${instId}/${group.fullName}`) : undefined;
      let repoId = fromMirror ?? null;
      let fullName = group.fullName;

      if (repoId == null) {
        if (apiCalls >= REPO_LINK_API_BUDGET) continue;
        apiCalls += 1;
        const resolved = await this.lookupRepoIdentity(group.installationId, group.fullName);
        if (!resolved) continue;
        repoId = resolved.repoId;
        fullName = resolved.fullName;
      }

      await this.adoptRepoIdentity(
        group.rows.map((r) => ({ ...r, githubRepoId: null })),
        repoId,
        fullName
      );
      linked += group.rows.length;
    }
    return linked;
  }

  /** Ask GitHub what a stored owner/name is now. Follows renames; null if it is gone. */
  private async lookupRepoIdentity(
    installationId: bigint,
    fullName: string
  ): Promise<{ repoId: bigint; fullName: string } | null> {
    try {
      const token = await this.getOrRefreshInstallationToken(installationId);
      const response = await fetch(`https://api.github.com/repos/${fullName}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json'
        }
      });
      if (!response.ok) return null;
      const body: any = await response.json();
      if (!body?.id || !body?.full_name) return null;
      if (body.full_name !== fullName) {
        console.log(`[GitHub] ${fullName} is now ${body.full_name}`);
      }
      return { repoId: BigInt(body.id), fullName: body.full_name };
    } catch (e: any) {
      console.warn(`[GitHub] could not resolve ${fullName}:`, e?.message ?? e);
      return null;
    }
  }

  async touchRepoPush(
    installationId: bigint,
    repo: { id?: number; full_name?: string }
  ): Promise<void> {
    if (!repo?.id) return;
    const inst = await this.prisma.gitHubAppInstallation.findUnique({ where: { installationId } });
    if (!inst) return;
    await this.prisma.gitHubRepoMirror.updateMany({
      where: { appInstallationId: inst.id, githubRepoId: BigInt(repo.id) },
      data: { pushedAt: new Date(), ...(repo.full_name ? { fullName: repo.full_name } : {}) }
    });
  }

  // Resolve an access token for a specific repo: prefers App installation token, falls back to user OAuth token.
  async resolveCloneAccess(input: {
    owner: string;
    repo: string;
    branch: string;
    boundInstallationId: bigint | null;
    linkedBy: string | null;
  }): Promise<{ installationId: bigint; token: string } | null> {
    const { owner, repo, branch, boundInstallationId, linkedBy } = input;
    const installation = await this.findInstallationForRepo(owner, repo);
    if (!installation) return null;
    const { installationId } = installation;
    if (
      boundInstallationId !== installationId &&
      !(linkedBy && (await this.userMaintainsRepo(linkedBy, owner, repo)))
    ) {
      return null;
    }
    const submodules = await this.allowedSubmodules(installationId, owner, repo, branch, linkedBy);
    if (submodules.length > 0) {
      try {
        const { token } = await this.getInstallationAccessToken(installationId, [
          repo,
          ...submodules
        ]);
        return { installationId, token };
      } catch (e) {
        console.warn(
          `[GitHub] Clone token with submodules failed for ${owner}/${repo}: ${(e as Error).message}`
        );
      }
    }
    const { token } = await this.getInstallationAccessToken(installationId, [repo]);
    return { installationId, token };
  }

  private async allowedSubmodules(
    installationId: bigint,
    owner: string,
    repo: string,
    branch: string,
    linkedBy: string | null
  ): Promise<string[]> {
    if (!linkedBy) return [];
    const token = await this.getOrRefreshInstallationToken(installationId);
    const allowed: string[] = [];
    const seen = new Set([repo.toLowerCase()]);
    let frontier: Array<{ repo: string; ref?: string }> = [{ repo, ref: branch }];
    for (let depth = 0; depth < MAX_SUBMODULE_DEPTH && frontier.length > 0; depth++) {
      const next: Array<{ repo: string }> = [];
      for (const source of frontier) {
        const gitmodules = await this.getFileContent(
          token,
          owner,
          source.repo,
          '.gitmodules',
          source.ref
        ).catch(() => null);
        if (!gitmodules) continue;
        for (const name of submoduleRepos(gitmodules, owner, source.repo)) {
          if (seen.has(name.toLowerCase()) || seen.size > MAX_SUBMODULE_CHECKS) continue;
          seen.add(name.toLowerCase());
          const permitted =
            (await this.verifyUserCanAccessRepo(linkedBy, owner, name).catch(() => false)) &&
            (await this.isRepoAccessibleByInstallation(installationId, owner, name).catch(
              () => false
            ));
          if (!permitted) continue;
          allowed.push(name);
          next.push({ repo: name });
        }
      }
      frontier = next;
    }
    return allowed;
  }

  async resolveRepoToken(userId: string, owner: string, repo: string): Promise<string | null> {
    if (personalSourceSelectionRefused()) return null;
    const installation = await this.findInstallationForRepo(owner, repo);
    if (installation) {
      try {
        return await this.getOrRefreshInstallationToken(installation.installationId);
      } catch (e) {
        console.warn(
          `[GitHub] Installation token failed for ${owner}/${repo}, trying user token:`,
          e
        );
      }
    }

    // Fall back to user OAuth token (auto-refresh if expired)
    return this.getValidUserToken(userId);
  }

  private readonly userInstallationsCache = new Map<
    string,
    { at: number; epoch: string; rows: any[] }
  >();

  private static readonly INSTALLATIONS_CACHE_MS = 5 * 60 * 1000;

  private static readonly ACCESSIBLE_REPOS_FRESH_MS = 60 * 1000;

  private static readonly ACCESSIBLE_REPOS_KEEP_MS = 10 * 60 * 1000;

  private static readonly REPO_ACCESS_TTL_MS = 2 * 60 * 1000;

  private static readonly MIRROR_STALE_MS = 24 * 60 * 60 * 1000;

  private static readonly EPOCH_KEY = 'github:installations-epoch';

  private async installationsEpoch(userId: string): Promise<string> {
    const [global, own] = await Promise.all([
      this.cache.get<number>(GitHubService.EPOCH_KEY),
      this.cache.get<number>(`${GitHubService.EPOCH_KEY}:${userId}`)
    ]);
    return `${global ?? 0}.${own ?? 0}`;
  }

  private forgetUserGitHub(userId: string) {
    this.userInstallationsCache.delete(userId);
    return this.cache.set(
      `${GitHubService.EPOCH_KEY}:${userId}`,
      Date.now(),
      7 * 24 * 60 * 60 * 1000
    );
  }

  clearUserInstallationsCache() {
    this.userInstallationsCache.clear();
    void this.cache.set(GitHubService.EPOCH_KEY, Date.now(), 7 * 24 * 60 * 60 * 1000);
  }

  async userInstallationsCached(userId: string, epoch?: string): Promise<any[]> {
    const current = epoch ?? (await this.installationsEpoch(userId));
    const cached = this.userInstallationsCache.get(userId);
    if (
      cached &&
      cached.epoch === current &&
      Date.now() - cached.at < GitHubService.INSTALLATIONS_CACHE_MS
    ) {
      return cached.rows;
    }
    const rows = await this.getUserInstallations(userId);
    if (this.userInstallationsCache.size > 5_000) this.userInstallationsCache.clear();
    if (rows.length > 0) {
      this.userInstallationsCache.set(userId, { at: Date.now(), epoch: current, rows });
    } else {
      this.userInstallationsCache.delete(userId);
    }
    return rows;
  }

  private async accessibleRepoIds(
    epoch: string,
    userId: string,
    userToken: string,
    installationId: bigint
  ): Promise<Set<string> | null> {
    const key = `github:accessible:${epoch}:${userId}:${installationId}`;
    try {
      const ids = await this.cache.snapshot(
        key,
        {
          freshMs: GitHubService.ACCESSIBLE_REPOS_FRESH_MS,
          keepMs: GitHubService.ACCESSIBLE_REPOS_KEEP_MS
        },
        async () => {
          const found = await this.getUserAccessibleRepoIds(userToken, installationId);
          if (!found) throw new Error(`accessible repos unresolved for ${installationId}`);
          return [...found];
        }
      );
      return new Set(ids);
    } catch {
      return null;
    }
  }

  async resolveReadAccessToken(
    user: { id: string; githubAccessToken?: string | null },
    owner: string,
    repo: string
  ): Promise<string | null> {
    type Decision = { via: 'installation'; installationId: string } | { via: 'user' | 'public' };
    if (personalSourceSelectionRefused()) {
      return (await this.isRepoPublic(owner, repo)) ? '' : null;
    }
    const epoch = await this.installationsEpoch(user.id);
    const key = `github:repo-access:${epoch}:${user.id}:${owner.toLowerCase()}/${repo.toLowerCase()}`;
    const cached = await this.cache.get<Decision>(key);
    if (cached) {
      const token = await this.tokenForDecision(user, cached).catch(() => null);
      if (token !== null) return token;
      await this.cache.del(key);
    }

    let decision: Decision | null = null;
    let token: string | null = null;
    if (user.githubAccessToken) {
      const [canAccess, installation] = await Promise.all([
        this.verifyUserCanAccessRepo(user.id, owner, repo),
        this.findInstallationForRepo(owner, repo).catch(() => null)
      ]);
      if (canAccess) {
        if (installation) {
          token = await this.getOrRefreshInstallationToken(installation.installationId).catch(
            () => null
          );
          if (token) {
            decision = {
              via: 'installation',
              installationId: installation.installationId.toString()
            };
          }
        }
        if (!token) {
          token = await this.getValidUserToken(user.id);
          if (token) decision = { via: 'user' };
        }
      }
    }
    if (!decision) {
      if (!(await this.isRepoPublic(owner, repo))) return null;
      decision = { via: 'public' };
      token = await this.tokenForDecision(user, decision);
    }
    await this.cache.set(key, decision, GitHubService.REPO_ACCESS_TTL_MS);
    return token ?? '';
  }

  private async tokenForDecision(
    user: { id: string; githubAccessToken?: string | null },
    decision: { via: 'installation'; installationId: string } | { via: 'user' | 'public' }
  ): Promise<string | null> {
    if (decision.via === 'installation') {
      return this.getOrRefreshInstallationToken(BigInt(decision.installationId));
    }
    if (decision.via === 'user') return this.getValidUserToken(user.id);
    if (!user.githubAccessToken) return '';
    return (await this.getValidUserToken(user.id)) ?? '';
  }

  // Repo metadata is served from the DB mirror (kept current by installation,
  // repository, and push webhooks), never from live GitHub pagination. An
  // installation with no mirror rows is seeded synchronously on first read;
  // a stale mirror reseeds in the background.
  //
  // The mirror is installation-scoped, so it is then intersected with the repos
  // this user can actually see through each installation. An org member with
  // access to one repo must not be shown the rest of the org's private repos
  // just because the App is installed org-wide.
  async getAllUserRepositories(userId: string): Promise<{
    repos: GitHubRepo[];
    installations: any[];
    hasInstallations: boolean;
    userLinked: boolean;
  }> {
    const epoch = await this.installationsEpoch(userId);
    const [installations, userToken] = await Promise.all([
      this.userInstallationsCached(userId, epoch),
      this.getValidUserToken(userId)
    ]);
    const userLinked = Boolean(userToken);

    if (installations.length === 0) {
      return { repos: [], installations: [], hasInstallations: false, userLinked };
    }

    // Without a user token we cannot tell which of the installation's repos this
    // person is allowed to see, so we show none rather than all of them.
    if (!userToken) {
      return { repos: [], installations: [], hasInstallations: true, userLinked };
    }

    const instIds = installations.map((i) => i.id);
    const loadRows = () =>
      this.prisma.gitHubRepoMirror.findMany({
        where: { appInstallationId: { in: instIds } },
        orderBy: [{ pushedAt: { sort: 'desc', nulls: 'last' } }, { fullName: 'asc' }]
      });

    let rows = await loadRows();
    const seeded = new Set(rows.map((r) => r.appInstallationId));
    const unseeded = installations.filter((i) => !seeded.has(i.id));
    if (unseeded.length > 0) {
      await Promise.all(
        unseeded.map((i) =>
          this.syncInstallationRepos(i).catch((e) =>
            console.error(
              `[GitHub] mirror seed failed for installation ${i.installationId}:`,
              e?.message ?? e
            )
          )
        )
      );
      rows = await loadRows();
    } else {
      const oldestByInst = new Map<string, number>();
      for (const r of rows) {
        const t = r.syncedAt.getTime();
        const prev = oldestByInst.get(r.appInstallationId);
        if (prev === undefined || t < prev) oldestByInst.set(r.appInstallationId, t);
      }
      for (const i of installations) {
        const oldest = oldestByInst.get(i.id);
        if (oldest !== undefined && Date.now() - oldest > GitHubService.MIRROR_STALE_MS) {
          void this.syncInstallationRepos(i).catch(() => {});
        }
      }
    }

    const instById = new Map(installations.map((i) => [i.id, i]));

    const allowedByInst = new Map<string, Set<string> | null>(
      await Promise.all(
        installations.map(async (i): Promise<[string, Set<string> | null]> => [
          i.id,
          await this.accessibleRepoIds(epoch, userId, userToken, i.installationId)
        ])
      )
    );

    rows = rows.filter(
      (r) => allowedByInst.get(r.appInstallationId)?.has(r.githubRepoId.toString()) ?? false
    );

    const countByInst = new Map<string, number>();
    for (const r of rows) {
      countByInst.set(r.appInstallationId, (countByInst.get(r.appInstallationId) ?? 0) + 1);
    }

    const repos = rows.flatMap((r) => {
      const inst = instById.get(r.appInstallationId);
      if (!inst) return [];
      return [
        {
          id: Number(r.githubRepoId),
          full_name: r.fullName,
          private: r.private,
          default_branch: r.defaultBranch ?? 'main',
          clone_url: `https://github.com/${r.fullName}.git`,
          pushed_at: r.pushedAt?.toISOString() ?? null,
          installationId: inst.installationId.toString(),
          accountLogin: inst.accountLogin
        } as any
      ];
    });

    const installationData = installations.map((i) => ({
      id: i.id,
      installationId: i.installationId.toString(),
      accountLogin: i.accountLogin,
      accountType: i.accountType,
      repositoryCount: countByInst.get(i.id) ?? 0
    }));

    return { repos, installations: installationData, hasInstallations: true, userLinked };
  }

  private static readonly REPO_SEARCH_FRESH_MS = 60 * 1000;

  private static readonly REPO_SEARCH_KEEP_MS = 5 * 60 * 1000;

  async searchUserRepositories(userId: string, account: unknown, rawQuery: unknown) {
    const epoch = await this.installationsEpoch(userId);
    const installation = pickSearchInstallation(
      await this.userInstallationsCached(userId, epoch),
      account
    );
    if (!installation) throw new RepoSearchError('not_installed');
    const token = await this.getValidUserToken(userId);
    if (!token) throw new RepoSearchError('reauth');

    const query = normalizeRepoQuery(installation.accountLogin, rawQuery);
    const login = installation.accountLogin;
    const installationId = installation.installationId.toString();
    const shape = (repos: SearchedRepo[]) => ({
      account: login,
      query: query.key,
      repositories: repos.slice(0, REPO_SEARCH_LIMIT).map((r) => ({
        id: r.id,
        name: r.name,
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch,
        clone_url: `https://github.com/${r.full_name}.git`,
        pushed_at: r.pushed_at,
        updated_at: r.updated_at,
        installationId,
        accountLogin: login
      }))
    });
    if (query.foreignOwner) return shape([]);

    const key = `github:repo-search:${epoch}:${userId}:${installationId}:${query.key}`;
    const [found, exact] = await Promise.all([
      this.cache.snapshot(
        key,
        {
          freshMs: GitHubService.REPO_SEARCH_FRESH_MS,
          keepMs: GitHubService.REPO_SEARCH_KEEP_MS
        },
        () => this.runRepoSearch(token, installation, query.terms)
      ),
      query.exactName ? this.lookupOwnedRepo(token, login, query.exactName) : null
    ]);
    const merged = rankRepos(mergeExact(found, exact), query.terms);
    return shape(await this.enrichFromMirror(installation.id, merged));
  }

  private async runRepoSearch(
    token: string,
    installation: { accountLogin: string; accountType: string },
    terms: string[]
  ): Promise<SearchedRepo[]> {
    const params = new URLSearchParams({
      q: buildSearchQ(installation, terms),
      sort: 'updated',
      order: 'desc',
      per_page: String(REPO_SEARCH_LIMIT)
    });
    let response: Response;
    try {
      response = await fetch(`https://api.github.com/search/repositories?${params}`, {
        headers: this.githubApiHeaders(token),
        signal: AbortSignal.timeout(8000)
      });
    } catch {
      throw new RepoSearchError('unavailable');
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const kind = classifyGitHubFailure(response.status, response.headers, body?.message ?? '');
      if (kind === 'invalid') return [];
      throw new RepoSearchError(
        kind,
        kind === 'rate_limited' ? retryAfterSeconds(response.headers) : null
      );
    }
    const data = await response.json();
    return (Array.isArray(data?.items) ? data.items : [])
      .map(toSearchedRepo)
      .filter(
        (r: SearchedRepo | null): r is SearchedRepo => !!r && ownedBy(r, installation.accountLogin)
      );
  }

  private async lookupOwnedRepo(
    token: string,
    account: string,
    name: string
  ): Promise<SearchedRepo | null> {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(account)}/${encodeURIComponent(name)}`,
        { headers: this.githubApiHeaders(token), signal: AbortSignal.timeout(5000) }
      );
      if (!response.ok) return null;
      const repo = toSearchedRepo(await response.json());
      return repo && ownedBy(repo, account) ? repo : null;
    } catch {
      return null;
    }
  }

  private async enrichFromMirror(
    appInstallationId: string,
    repos: SearchedRepo[]
  ): Promise<SearchedRepo[]> {
    if (repos.length === 0 || !/^[0-9a-f-]{36}$/i.test(appInstallationId)) return repos;
    type MirrorRow = { githubRepoId: bigint; defaultBranch: string | null; pushedAt: Date | null };
    let rows: MirrorRow[] = [];
    try {
      rows = await this.prisma.gitHubRepoMirror.findMany({
        where: { appInstallationId, githubRepoId: { in: repos.map((r) => BigInt(r.id)) } },
        select: { githubRepoId: true, defaultBranch: true, pushedAt: true }
      });
    } catch {
      return repos;
    }
    if (rows.length === 0) return repos;
    const byId = new Map(rows.map((r) => [Number(r.githubRepoId), r]));
    return repos.map((r) => {
      const row = byId.get(r.id);
      if (!row) return r;
      const searched = r.pushed_at ? Date.parse(r.pushed_at) : 0;
      const newer = row.pushedAt && row.pushedAt.getTime() > searched ? row.pushedAt : null;
      return {
        ...r,
        default_branch: row.defaultBranch || r.default_branch,
        pushed_at: newer ? newer.toISOString() : r.pushed_at
      };
    });
  }

  /**
   * Installations the current user can see on GitHub.
   *
   * GitHub's `/user/installations` endpoint is the source of truth: it
   * returns installations accessible through org membership, not just ones
   * the user personally installed. We cross-reference with DB rows for our
   * internal UUID + cached tokens, and backfill any GitHub-reported
   * installations that are missing from the DB.
   */
  async getUserInstallations(userId: string) {
    const dbRows = await this.prisma.gitHubAppInstallation.findMany({
      where: { suspendedAt: null, userId },
      orderBy: { accountLogin: 'asc' }
    });

    const userToken = await this.getValidUserToken(userId);
    if (!userToken) {
      return dbRows;
    }

    let githubInstallations: {
      id: number;
      account: { login: string; id: number; type: string } | null;
      repository_selection: 'all' | 'selected';
    }[] = [];
    try {
      const response = await fetch('https://api.github.com/user/installations?per_page=100', {
        headers: {
          Authorization: `Bearer ${userToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) {
        const data = await response.json();
        githubInstallations = data.installations ?? [];
      } else if (response.status === 401) {
        return dbRows;
      }
    } catch (e) {
      console.warn('[GitHub] /user/installations lookup failed, falling back to DB:', e);
      return dbRows;
    }

    const dbByInstallationId = new Map<string, (typeof dbRows)[number]>();
    for (const row of dbRows) {
      dbByInstallationId.set(row.installationId.toString(), row);
    }

    // Backfill installations GitHub knows about that we don't have in the DB
    const toBackfill = githubInstallations.filter(
      (inst) => inst.account?.login && !dbByInstallationId.has(String(inst.id))
    );
    for (const inst of toBackfill) {
      try {
        const row = await this.prisma.gitHubAppInstallation.upsert({
          where: { installationId: BigInt(inst.id) },
          create: {
            userId: null,
            installationId: BigInt(inst.id),
            accountLogin: inst.account!.login,
            accountId: BigInt(inst.account!.id),
            accountType: inst.account!.type,
            repositorySelection: inst.repository_selection
          },
          update: {
            accountLogin: inst.account!.login,
            accountType: inst.account!.type,
            repositorySelection: inst.repository_selection
          }
        });
        dbByInstallationId.set(row.installationId.toString(), row);
      } catch (e) {
        console.warn(`[GitHub] Failed to backfill installation ${inst.id}:`, e);
      }
    }

    return githubInstallations
      .filter((inst) => inst.account?.login)
      .map((inst) => {
        const dbRow = dbByInstallationId.get(String(inst.id));
        if (dbRow) return dbRow;
        return {
          id: `gh-${inst.id}`,
          installationId: BigInt(inst.id),
          userId: null,
          accountLogin: inst.account!.login,
          accountId: BigInt(inst.account!.id),
          accountType: inst.account!.type,
          repositorySelection: inst.repository_selection,
          accessToken: null,
          tokenExpiresAt: null,
          suspendedAt: null,
          createdAt: new Date(),
          updatedAt: new Date()
        } as unknown as (typeof dbRows)[number];
      })
      .sort((a, b) => a.accountLogin.localeCompare(b.accountLogin));
  }

  /**
   * Why auto-deploy cannot be turned on, in words that name the fix.
   *
   * An installation covering the account is not enough: an App added with
   * "only select repositories" has to have this one selected, and a repo
   * created after the install is not selected retroactively. That is the case
   * that reads as a working setup and never delivers a webhook.
   */
  autoDeployUnavailableMessage(owner: string, repo: string): string {
    let where = 'Install it';
    try {
      where = `Install it at ${this.getAppInstallationUrl()}`;
    } catch {
      where = 'Install it from the GitHub App settings';
    }
    return (
      `The GitHub App isn't installed on ${owner}/${repo}, so pushes can't reach Orchard ` +
      "and auto-deploy can't be enabled. " +
      `${where}, and if it is installed with "only select repositories", add ${repo} to the ` +
      "selection: a repository created after the install isn't added to it automatically. " +
      'Manual builds and rebuilds work without this.'
    );
  }

  getAppInstallationUrl(): string {
    const appSlug = this.appConfig.get().slug;
    if (!appSlug) {
      throw new BadRequestException('GitHub App slug not configured');
    }
    return `https://github.com/apps/${appSlug}/installations/new`;
  }

  // Create a check run (appears under "Checks" on commits)
  async createCheckRun(
    installationId: bigint,
    owner: string,
    repo: string,
    options: {
      name: string;
      headSha: string;
      status?: 'queued' | 'in_progress' | 'completed';
      conclusion?:
        | 'success'
        | 'failure'
        | 'neutral'
        | 'cancelled'
        | 'skipped'
        | 'timed_out'
        | 'action_required';
      detailsUrl?: string;
      externalId?: string;
      output?: {
        title: string;
        summary: string;
        text?: string;
      };
    }
  ): Promise<{ id: number; html_url: string }> {
    const token = await this.getOrRefreshInstallationToken(installationId);

    const body: Record<string, unknown> = {
      name: options.name,
      head_sha: options.headSha,
      status: options.status || 'queued'
    };

    if (options.conclusion) {
      body.conclusion = options.conclusion;
      body.completed_at = new Date().toISOString();
    }

    if (options.status === 'in_progress') {
      body.started_at = new Date().toISOString();
    }

    if (options.detailsUrl) {
      body.details_url = options.detailsUrl;
    }

    if (options.externalId) {
      body.external_id = options.externalId;
    }

    if (options.output) {
      body.output = options.output;
    }

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`[GitHub] Failed to create check run: ${error}`);
      throw new BadRequestException(`Failed to create check run: ${error}`);
    }

    const data = await response.json();
    return { id: data.id, html_url: data.html_url };
  }

  // Update a check run (update status and logs)
  async updateCheckRun(
    installationId: bigint,
    owner: string,
    repo: string,
    checkRunId: number,
    options: {
      status?: 'queued' | 'in_progress' | 'completed';
      conclusion?:
        | 'success'
        | 'failure'
        | 'neutral'
        | 'cancelled'
        | 'skipped'
        | 'timed_out'
        | 'action_required';
      detailsUrl?: string;
      output?: {
        title: string;
        summary: string;
        text?: string;
      };
    }
  ): Promise<void> {
    const token = await this.getOrRefreshInstallationToken(installationId);

    const body: Record<string, unknown> = {};

    if (options.status) {
      body.status = options.status;
    }

    if (options.conclusion) {
      body.conclusion = options.conclusion;
      body.completed_at = new Date().toISOString();
    }

    if (options.detailsUrl) {
      body.details_url = options.detailsUrl;
    }

    if (options.output) {
      body.output = options.output;
    }

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${checkRunId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`[GitHub] Failed to update check run: ${error}`);
      // Don't throw - we don't want to break the build if check update fails
    }
  }
}
