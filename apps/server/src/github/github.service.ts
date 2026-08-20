import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { OAuthService } from '../auth/oauth.service';
import { GithubAppConfigService } from './github-app-config.service';
import {
  detectApps,
  primaryApp,
  type DetectedApp,
  type WorkspaceInfo,
  type RepoBuildConfig,
  type FileReader,
} from './framework-detect';

/** What the create form and the CLI get back from a detection run. */
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
}

/** Long enough to cover the create form's repeated detects, short enough that a
 *  push shows up on the next visit. */
const DETECT_CACHE_TTL_MS = 60_000;
const DETECT_CACHE_MAX = 200;

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

@Injectable()
export class GitHubService {
  private get clientId(): string {
    return this.appConfig.get().clientId;
  }

  private get clientSecret(): string {
    return this.appConfig.get().clientSecret;
  }

  getOAuthClientId(): string | null {
    return this.appConfig.get().clientId;
  }

  private readonly repoCache = new Map<string, CachedRepos>();

  private readonly CACHE_TTL = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauthService: OAuthService,
    private readonly appConfig: GithubAppConfigService,
  ) {}

  private getCacheKey(accessToken: string, maxPages: number): string {
    return `${accessToken.substring(0, 10)}_${maxPages}`;
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
      code,
    });

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: params.toString(),
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
    const refreshExpiresIn = typeof data.refresh_token_expires_in === 'number' ? data.refresh_token_expires_in : null;
    return {
      accessToken: data.access_token,
      expiresAt: expiresIn ? new Date(now + expiresIn * 1000) : null,
      refreshToken: data.refresh_token ?? null,
      refreshTokenExpiresAt: refreshExpiresIn ? new Date(now + refreshExpiresIn * 1000) : null,
    };
  }

  // Refresh a user's GitHub access token using the stored refresh token.
  // Returns the new access token, or null if refresh failed (user must reauthorize).
  async refreshUserToken(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { githubRefreshToken: true, githubRefreshTokenExpiresAt: true },
    });
    if (!user?.githubRefreshToken) return null;
    if (user.githubRefreshTokenExpiresAt && user.githubRefreshTokenExpiresAt.getTime() <= Date.now()) {
      return null;
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: user.githubRefreshToken,
    });

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: params.toString(),
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
        githubAccessToken: parsed.accessToken,
        githubTokenExpiresAt: parsed.expiresAt,
        // GitHub rotates the refresh token on each use — only overwrite if returned.
        ...(parsed.refreshToken ? {
          githubRefreshToken: parsed.refreshToken,
          githubRefreshTokenExpiresAt: parsed.refreshTokenExpiresAt,
        } : {}),
      },
    });
    return parsed.accessToken;
  }

  // Return a usable access token for the user, refreshing if expired/near-expiry.
  // Returns null if no token, refresh failed, or refresh token also expired.
  async getValidUserToken(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { githubAccessToken: true, githubTokenExpiresAt: true, githubRefreshToken: true },
    });
    if (!user?.githubAccessToken) return null;

    // Non-expiring token (app config has "Expire user authorization tokens" off).
    if (!user.githubTokenExpiresAt) return user.githubAccessToken;

    // Refresh if within 2 minutes of expiry.
    const bufferMs = 2 * 60 * 1000;
    if (user.githubTokenExpiresAt.getTime() - bufferMs > Date.now()) {
      return user.githubAccessToken;
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
        githubRefreshTokenExpiresAt: null,
      },
    });
  }

  async getGitHubUser(accessToken: string): Promise<GitHubUser> {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
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
      select: { id: true },
    });
    if (existing && existing.id !== userId) {
      throw new ConflictException(
        `This GitHub account (@${githubUser.login}) is already linked to another Orchard account. Disconnect it there first, then try again.`,
      );
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        githubId: String(githubUser.id),
        githubUsername: githubUser.login,
        githubAccessToken: tokens.accessToken,
        githubTokenExpiresAt: tokens.expiresAt,
        githubRefreshToken: tokens.refreshToken,
        githubRefreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      },
    });
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
        githubRefreshTokenExpiresAt: null,
      },
    });
  }

  async getUserRepositories(accessToken: string, maxPages = 3): Promise<GitHubRepo[]> {
    const cached = this.getCachedRepos(accessToken, maxPages);
    if (cached) {
      return cached;
    }

    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
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
        .filter((result): result is PromiseFulfilledResult<GitHubRepo[]> => 
          result.status === 'fulfilled'
        )
        .map(result => result.value)
    ].flat();
    
    this.setCachedRepos(accessToken, maxPages, allRepos);
    return allRepos;
  }

  private githubApiHeaders(accessToken?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
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
          headers: this.githubApiHeaders(accessToken),
        },
      );
      if (!response.ok) throw new BadRequestException('Failed to fetch repository branches');
      return response.json();
    };

    // Probe page 1 first; if it's full, fan out the rest in parallel.
    const first = await fetchPage(1);
    if (first.length < 100) return first;
    const rest = await Promise.all(
      Array.from({ length: MAX_PAGES - 1 }, (_, i) => fetchPage(i + 2)),
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
      headers: this.githubApiHeaders(accessToken),
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
        headers: this.githubApiHeaders(accessToken),
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
      // Skip node_modules and .git paths
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

    if (!response.ok) {
      throw new BadRequestException('Failed to fetch file content');
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

  parseEnvVars(dockerfileContent: string): { key: string; value: string }[] {
    const envVars: { key: string; value: string }[] = [];
    const lines = dockerfileContent.split('\n');
    const seenKeys = new Set<string>();

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.toUpperCase().startsWith('ENV ')) {
        const rest = trimmed.substring(4).trim();
        // Handle ENV KEY=VALUE KEY2=VALUE2 format
        const kvMatches = rest.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g);
        let matched = false;
        for (const m of kvMatches) {
          matched = true;
          const key = m[1];
          let value = m[2];
          // Strip surrounding quotes
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            envVars.push({ key, value });
          }
        }
        // Handle ENV KEY VALUE format (single key-value, no equals sign)
        if (!matched) {
          const spaceMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/);
          if (spaceMatch) {
            const key = spaceMatch[1];
            const value = spaceMatch[2].trim();
            if (!seenKeys.has(key)) {
              seenKeys.add(key);
              envVars.push({ key, value });
            }
          }
        }
      }
    }

    return envVars;
  }

  async getDockerfileInfo(
    accessToken: string,
    owner: string,
    repo: string,
    dockerfilePath: string,
    branch?: string
  ): Promise<{ exposedPorts: number[]; envVars: { key: string; value: string }[]; stages: string[] }> {
    const content = await this.getFileContent(accessToken, owner, repo, dockerfilePath, branch);
    return {
      exposedPorts: this.parseExposedPorts(content),
      envVars: this.parseEnvVars(content),
      stages: this.parseDockerfileStages(content),
    };
  }

  async getDefaultBranch(accessToken: string | null, owner: string, repo: string): Promise<string> {
    try {
      const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        headers: this.githubApiHeaders(accessToken ?? ''),
      });
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
   * fires when the branch list confirms the default branch.
   */
  async detectRepoConfig(
    accessToken: string,
    owner: string,
    repo: string,
    branch?: string
  ): Promise<RepoConfigDetection> {
    const key = [
      crypto.createHash('sha256').update(accessToken).digest('hex').slice(0, 16),
      owner,
      repo,
      branch ?? '',
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
   * repo containing a Dockerfile stops right there — there is nothing left to
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

    const empty = {
      apps: [] as DetectedApp[],
      workspace: { isWorkspace: false, packageManager: 'npm' } as WorkspaceInfo,
      repoConfig: null,
      rootDirectory: null,
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
    };

    if (dockerfiles.length > 0) {
      const dockerfilePath = [...dockerfiles].sort(
        (a, b) => a.split('/').length - b.split('/').length || a.length - b.length
      )[0];
      const info = await this.getDockerfileInfo(accessToken, owner, repo, dockerfilePath, branch).catch(
        () => null
      );
      return {
        buildType: 'dockerfile',
        dockerfilePath,
        dockerfiles,
        stages: info?.stages ?? [],
        ports: info?.exposedPorts ?? [],
        env: info?.envVars ?? [],
        framework: null,
        suggestedName,
        ...empty,
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
        ...empty,
      };
    }

    const { apps, workspace, repoConfig } = await detectApps(
      tree,
      this.repoFileReader(accessToken, owner, repo, branch),
    );
    // An orchard.json naming a directory picks the app; otherwise the usual
    // "recognised root app, else shallowest" rule applies.
    const primary = (repoConfig?.rootDirectory
      && apps.find((a) => a.dir === repoConfig.rootDirectory))
      || primaryApp(apps);

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

  // Webhook signature verification
  verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
    if (!signature || !secret) {
      return false;
    }

    const expectedSignature = `sha256=${  crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex')}`;

    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
    } catch {
      return false;
    }
  }

  // Generate a secure webhook secret
  generateWebhookSecret(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  // Create a GitHub webhook for a repository
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
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'web',
          active: true,
          events: ['push'],
          config: {
            url: webhookUrl,
            content_type: 'json',
            secret,
            insecure_ssl: '0',
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new BadRequestException(`Failed to create webhook: ${error}`);
    }

    return await response.json();
  }

  // Delete a GitHub webhook
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
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
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
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref,
          environment,
          description: description || `Deploying ${ref} to ${environment}`,
          auto_merge: false,
          required_contexts: [], // Skip status checks for now
        }),
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
      auto_inactive: true,
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
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
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
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    if (!response.ok) {
      throw new BadRequestException('Failed to get commit SHA');
    }

    const data = await response.json();
    return data.sha;
  }

  // Parse repository owner and name from URL
  parseRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
    // Handle various GitHub URL formats
    // https://github.com/owner/repo
    // https://github.com/owner/repo.git
    // git@github.com:owner/repo.git
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

  // ============================================
  // GitHub App Methods
  // ============================================

  // Generate a JWT for GitHub App authentication
  private generateAppJwt(): string {
    const { appId, privateKey } = this.appConfig.get();

    if (!appId || !privateKey) {
      throw new BadRequestException('GitHub App not configured. Create one from Admin, or set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.');
    }

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 60, // Issued 60 seconds ago to account for clock drift
      exp: now + 600, // Expires in 10 minutes (max allowed)
      iss: appId,
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

  // Get an installation access token for a specific installation
  async getInstallationAccessToken(installationId: bigint): Promise<{ token: string; expiresAt: Date }> {
    const jwt = this.generateAppJwt();

    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new BadRequestException(`Failed to get installation access token: ${error}`);
    }

    const data = await response.json();
    return {
      token: data.token,
      expiresAt: new Date(data.expires_at),
    };
  }

  // Get or refresh installation access token (with caching)
  async getOrRefreshInstallationToken(installationId: bigint): Promise<string> {
    // Check if we have a cached token
    const installation = await this.prisma.gitHubAppInstallation.findUnique({
      where: { installationId },
    });

    if (installation?.accessToken && installation.tokenExpiresAt) {
      // Check if token is still valid (with 5 minute buffer)
      const bufferTime = 5 * 60 * 1000;
      if (new Date(installation.tokenExpiresAt).getTime() - bufferTime > Date.now()) {
        return installation.accessToken;
      }
    }

    // Get a new token
    const { token, expiresAt } = await this.getInstallationAccessToken(installationId);

    // Cache the token if we have a DB record for this installation
    if (installation) {
      await this.prisma.gitHubAppInstallation.update({
        where: { installationId },
        data: {
          accessToken: token,
          tokenExpiresAt: expiresAt,
        },
      });
    }

    return token;
  }

  // Handle GitHub App installation event
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
    console.log(`[GitHub App] Installation ${action} by ${sender.login} for ${installation.account.login}`);

    if (action === 'created') {
      const user = await this.prisma.user.findFirst({
        where: { githubId: String(sender.id) },
      });

      if (!user) {
        console.warn(`[GitHub App] No Orchard user for GitHub ID ${sender.id} (${sender.login}) — creating installation without user link`);
      }

      await this.prisma.gitHubAppInstallation.upsert({
        where: { installationId: BigInt(installation.id) },
        create: {
          userId: user?.id ?? null,
          installationId: BigInt(installation.id),
          accountLogin: installation.account.login,
          accountId: BigInt(installation.account.id),
          accountType: installation.account.type,
          repositorySelection: installation.repository_selection,
        },
        update: {
          ...(user ? { userId: user.id } : {}),
          accountLogin: installation.account.login,
          accountId: BigInt(installation.account.id),
          accountType: installation.account.type,
          repositorySelection: installation.repository_selection,
          suspendedAt: null,
        },
      });

      console.log(`[GitHub App] Installation created for ${installation.account.login}${user ? ` (linked to ${user.username})` : ' (no user link)'}`);
    } else if (action === 'deleted') {
      // Delete the installation record
      await this.prisma.gitHubAppInstallation.deleteMany({
        where: { installationId: BigInt(installation.id) },
      });

      console.log(`[GitHub App] Installation deleted`);
    } else if (action === 'suspend') {
      await this.prisma.gitHubAppInstallation.updateMany({
        where: { installationId: BigInt(installation.id) },
        data: { suspendedAt: new Date() },
      });

      console.log(`[GitHub App] Installation suspended`);
    } else if (action === 'unsuspend') {
      await this.prisma.gitHubAppInstallation.updateMany({
        where: { installationId: BigInt(installation.id) },
        data: { suspendedAt: null },
      });

      console.log(`[GitHub App] Installation unsuspended`);
    }
  }

  // Get list of repositories accessible by an installation
  async getInstallationRepositories(installationId: bigint): Promise<GitHubRepo[]> {
    const token = await this.getOrRefreshInstallationToken(installationId);

    const repos: GitHubRepo[] = [];
    let page = 1;
    const perPage = 100;

    while (page <= 10) { // Max 10 pages
      const response = await fetch(
        `https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
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

  // Check if a repository is accessible by an installation
  async isRepoAccessibleByInstallation(installationId: bigint, owner: string, repo: string): Promise<boolean> {
    const token = await this.getOrRefreshInstallationToken(installationId);

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    return response.ok;
  }

  // Get GitHub App webhook secret
  getAppWebhookSecret(): string {
    const secret = this.appConfig.get().webhookSecret;
    if (!secret) {
      throw new BadRequestException('GitHub App webhook secret not configured');
    }
    return secret;
  }

  // Verify GitHub App webhook signature
  verifyAppWebhookSignature(payload: string, signature: string): boolean {
    const secret = this.getAppWebhookSecret();
    return this.verifyWebhookSignature(payload, signature, secret);
  }

  // Find installation for a repository
  async findInstallationForRepo(owner: string, repo: string): Promise<{ installationId: bigint } | null> {
    // Find installations that might have access to this repo
    const installations = await this.prisma.gitHubAppInstallation.findMany({
      where: {
        accountLogin: { equals: owner, mode: 'insensitive' },
        suspendedAt: null,
      },
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
        console.warn(`[GitHub App] Failed to check repo access for installation ${installation.installationId}:`, e);
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
            'Authorization': `Bearer ${jwt}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );
      if (response.ok) {
        const data = await response.json();
        const installationId = BigInt(data.id);

        // Backfill DB — non-blocking so the return isn't gated on it
        this.prisma.gitHubAppInstallation.upsert({
          where: { installationId },
          create: {
            userId: null,
            installationId,
            accountLogin: data.account?.login ?? owner,
            accountId: BigInt(data.account?.id ?? 0),
            accountType: data.account?.type ?? 'Organization',
            repositorySelection: data.repository_selection ?? 'all',
          },
          update: {
            accountLogin: data.account?.login ?? owner,
            accountType: data.account?.type ?? 'Organization',
            repositorySelection: data.repository_selection ?? 'all',
            suspendedAt: null,
          },
        }).then(() => {
          console.log(`[GitHub App] Backfilled installation ${installationId} for ${owner}/${repo} from GitHub API.`);
        }).catch((e) => {
          console.warn(`[GitHub App] Failed to backfill installation ${installationId}:`, e);
        });

        return { installationId };
      }
    } catch (e) {
      console.warn(`[GitHub App] GitHub API fallback failed for ${owner}/${repo}:`, e);
    }

    return null;
  }

  // Create GitHub deployment using app installation token
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

  // Update GitHub deployment status using app installation token
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
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
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
    const token = await this.getValidUserToken(userId);
    if (!token) return false;

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );
    return response.ok;
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
            'Authorization': `Bearer ${installationToken}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );
      if (!response.ok) {
        if (response.status === 404) return { repos: [], lastPage: null };
        throw new BadRequestException(`Failed to list installation repos: ${await response.text()}`);
      }
      const link = response.headers.get('link') || '';
      const lastMatch = link.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
      const data = await response.json();
      return {
        repos: data.repositories || [],
        lastPage: lastMatch ? Number(lastMatch[1]) : null,
      };
    };

    const first = await fetchPage(1);
    if (!first.lastPage || first.lastPage <= 1) return first.repos;

    const lastPage = Math.min(first.lastPage, maxPages);
    if (first.lastPage > maxPages) {
      console.warn(`[GitHub] installation has more than ${maxPages * perPage} repos, mirror truncated`);
    }
    const rest = await Promise.all(
      Array.from({ length: lastPage - 1 }, (_, i) => fetchPage(i + 2)),
    );
    return [first, ...rest].flatMap((r) => r.repos);
  }

  private readonly mirrorSyncInflight = new Set<string>();

  /**
   * Repo ids the user can actually see through one installation.
   *
   * The mirror table is installation-scoped, so it contains every repo the App
   * was granted — including ones an org member has no permission on. GitHub's
   * user-to-server `/user/installations/{id}/repositories` returns the
   * intersection of the installation grant and the caller's own access, which
   * is what we have to list against. Returns null when we could not determine
   * the set, so callers can fail closed rather than fall back to the mirror.
   */
  private async getUserAccessibleRepoIds(userToken: string, installationId: bigint): Promise<Set<string> | null> {
    const perPage = 100;
    const maxPages = 30;

    const fetchPage = async (page: number): Promise<{ ids: string[]; lastPage: number | null }> => {
      const response = await fetch(
        `https://api.github.com/user/installations/${installationId}/repositories?per_page=${perPage}&page=${page}`,
        {
          signal: AbortSignal.timeout(8000),
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
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
        lastPage: lastMatch ? Number(lastMatch[1]) : null,
      };
    };

    try {
      const first = await fetchPage(1);
      if (!first.lastPage || first.lastPage <= 1) return new Set(first.ids);

      const lastPage = Math.min(first.lastPage, maxPages);
      if (first.lastPage > maxPages) {
        console.warn(`[GitHub] user-accessible repo list for installation ${installationId} truncated at ${maxPages * perPage}`);
      }
      const rest = await Promise.all(
        Array.from({ length: lastPage - 1 }, (_, i) => fetchPage(i + 2)),
      );
      return new Set([first, ...rest].flatMap((r) => r.ids));
    } catch (e: any) {
      console.warn(`[GitHub] could not resolve user-accessible repos for installation ${installationId}:`, e?.message ?? e);
      return null;
    }
  }

  async syncInstallationRepos(appInstallation: { id: string; installationId: bigint }): Promise<void> {
    if (this.mirrorSyncInflight.has(appInstallation.id)) return;
    this.mirrorSyncInflight.add(appInstallation.id);
    try {
      const token = await this.getOrRefreshInstallationToken(appInstallation.installationId);
      const repos = await this.listInstallationRepos(token);
      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.gitHubRepoMirror.deleteMany({ where: { appInstallationId: appInstallation.id } }),
        this.prisma.gitHubRepoMirror.createMany({
          data: repos.map((r) => ({
            appInstallationId: appInstallation.id,
            githubRepoId: BigInt(r.id),
            fullName: r.full_name,
            private: Boolean(r.private),
            defaultBranch: r.default_branch ?? null,
            pushedAt: r.pushed_at ? new Date(r.pushed_at) : null,
            syncedAt: now,
          })),
          skipDuplicates: true,
        }),
      ]);
      console.log(`[GitHub] mirrored ${repos.length} repos for installation ${appInstallation.installationId}`);
    } finally {
      this.mirrorSyncInflight.delete(appInstallation.id);
    }
  }

  async syncInstallationReposById(installationId: bigint): Promise<void> {
    const inst = await this.prisma.gitHubAppInstallation.findUnique({ where: { installationId } });
    if (!inst) return;
    await this.syncInstallationRepos(inst);
  }

  async applyInstallationReposEvent(installationId: bigint, added: any[], removed: any[]): Promise<void> {
    const inst = await this.prisma.gitHubAppInstallation.findUnique({ where: { installationId } });
    if (!inst) return;
    if (removed.length > 0) {
      await this.prisma.gitHubRepoMirror.deleteMany({
        where: { appInstallationId: inst.id, githubRepoId: { in: removed.map((r) => BigInt(r.id)) } },
      });
    }
    for (const r of added) {
      await this.prisma.gitHubRepoMirror.upsert({
        where: { appInstallationId_githubRepoId: { appInstallationId: inst.id, githubRepoId: BigInt(r.id) } },
        update: { fullName: r.full_name, private: Boolean(r.private), syncedAt: new Date() },
        create: {
          appInstallationId: inst.id,
          githubRepoId: BigInt(r.id),
          fullName: r.full_name,
          private: Boolean(r.private),
          pushedAt: new Date(),
        },
      });
    }
  }

  async applyRepositoryEvent(installationId: bigint, action: string, repo: any): Promise<void> {
    if (!repo?.id) return;
    const inst = await this.prisma.gitHubAppInstallation.findUnique({ where: { installationId } });
    if (!inst) return;
    const githubRepoId = BigInt(repo.id);
    if (action === 'deleted' || action === 'transferred') {
      await this.prisma.gitHubRepoMirror.deleteMany({ where: { appInstallationId: inst.id, githubRepoId } });
      return;
    }
    await this.prisma.gitHubRepoMirror.updateMany({
      where: { appInstallationId: inst.id, githubRepoId },
      data: {
        fullName: repo.full_name,
        private: Boolean(repo.private),
        defaultBranch: repo.default_branch ?? null,
        syncedAt: new Date(),
      },
    });
  }

  async touchRepoPush(installationId: bigint, repo: { id?: number; full_name?: string }): Promise<void> {
    if (!repo?.id) return;
    const inst = await this.prisma.gitHubAppInstallation.findUnique({ where: { installationId } });
    if (!inst) return;
    await this.prisma.gitHubRepoMirror.updateMany({
      where: { appInstallationId: inst.id, githubRepoId: BigInt(repo.id) },
      data: { pushedAt: new Date(), ...(repo.full_name ? { fullName: repo.full_name } : {}) },
    });
  }

  // Resolve an access token for a specific repo — prefers App installation token, falls back to user OAuth token.
  async resolveRepoToken(userId: string, owner: string, repo: string): Promise<string | null> {
    // Try installation token first
    const installation = await this.findInstallationForRepo(owner, repo);
    if (installation) {
      try {
        return await this.getOrRefreshInstallationToken(installation.installationId);
      } catch (e) {
        console.warn(`[GitHub] Installation token failed for ${owner}/${repo}, trying user token:`, e);
      }
    }

    // Fall back to user OAuth token (auto-refresh if expired)
    return this.getValidUserToken(userId);
  }

  private readonly userInstallationsCache = new Map<string, { at: number; rows: any[] }>();

  private readonly accessibleReposCache = new Map<string, { at: number; ids: Set<string> }>();

  private static readonly INSTALLATIONS_CACHE_MS = 5 * 60 * 1000;

  private static readonly ACCESSIBLE_REPOS_CACHE_MS = 60 * 1000;

  private static readonly MIRROR_STALE_MS = 24 * 60 * 60 * 1000;

  clearUserInstallationsCache() {
    this.userInstallationsCache.clear();
    this.accessibleReposCache.clear();
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
  async getAllUserRepositories(userId: string): Promise<{ repos: GitHubRepo[]; installations: any[]; hasInstallations: boolean; userLinked: boolean }> {
    let installations: any[];
    const cachedInst = this.userInstallationsCache.get(userId);
    if (cachedInst && Date.now() - cachedInst.at < GitHubService.INSTALLATIONS_CACHE_MS) {
      installations = cachedInst.rows;
    } else {
      installations = await this.getUserInstallations(userId);
      this.userInstallationsCache.set(userId, { at: Date.now(), rows: installations });
    }

    const userToken = await this.getValidUserToken(userId);
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
        orderBy: [{ pushedAt: { sort: 'desc', nulls: 'last' } }, { fullName: 'asc' }],
      });

    let rows = await loadRows();
    const seeded = new Set(rows.map((r) => r.appInstallationId));
    const unseeded = installations.filter((i) => !seeded.has(i.id));
    if (unseeded.length > 0) {
      await Promise.all(
        unseeded.map((i) =>
          this.syncInstallationRepos(i).catch((e) =>
            console.error(`[GitHub] mirror seed failed for installation ${i.installationId}:`, e?.message ?? e),
          ),
        ),
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
        installations.map(async (i): Promise<[string, Set<string> | null]> => {
          const key = `${userId}:${i.installationId}`;
          const cached = this.accessibleReposCache.get(key);
          if (cached && Date.now() - cached.at < GitHubService.ACCESSIBLE_REPOS_CACHE_MS) {
            return [i.id, cached.ids];
          }
          const ids = await this.getUserAccessibleRepoIds(userToken, i.installationId);
          if (ids) this.accessibleReposCache.set(key, { at: Date.now(), ids });
          return [i.id, ids];
        }),
      ),
    );

    rows = rows.filter((r) => allowedByInst.get(r.appInstallationId)?.has(r.githubRepoId.toString()) ?? false);

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
          accountLogin: inst.accountLogin,
        } as any,
      ];
    });

    const installationData = installations.map((i) => ({
      id: i.id,
      installationId: i.installationId.toString(),
      accountLogin: i.accountLogin,
      accountType: i.accountType,
      repositoryCount: countByInst.get(i.id) ?? 0,
    }));

    return { repos, installations: installationData, hasInstallations: true, userLinked };
  }

  /**
   * Installations the current user can see on GitHub.
   *
   * GitHub's `/user/installations` endpoint is the source of truth — it
   * returns installations accessible through org membership, not just ones
   * the user personally installed. We cross-reference with DB rows for our
   * internal UUID + cached tokens, and backfill any GitHub-reported
   * installations that are missing from the DB.
   */
  async getUserInstallations(userId: string) {
    const dbRows = await this.prisma.gitHubAppInstallation.findMany({
      where: { suspendedAt: null, userId },
      orderBy: { accountLogin: 'asc' },
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
      const response = await fetch(
        'https://api.github.com/user/installations?per_page=100',
        {
          headers: {
            Authorization: `Bearer ${userToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(5000),
        },
      );
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
      (inst) => inst.account?.login && !dbByInstallationId.has(String(inst.id)),
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
            repositorySelection: inst.repository_selection,
          },
          update: {
            accountLogin: inst.account!.login,
            accountType: inst.account!.type,
            repositorySelection: inst.repository_selection,
          },
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
          updatedAt: new Date(),
        } as unknown as (typeof dbRows)[number];
      })
      .sort((a, b) => a.accountLogin.localeCompare(b.accountLogin));
  }

  // Get GitHub App installation URL
  getAppInstallationUrl(): string {
    const appSlug = this.appConfig.get().slug;
    if (!appSlug) {
      throw new BadRequestException('GitHub App slug not configured');
    }
    return `https://github.com/apps/${appSlug}/installations/new`;
  }

  // ============================================
  // GitHub Checks API Methods
  // ============================================

  // Create a check run (appears under "Checks" on commits)
  async createCheckRun(
    installationId: bigint,
    owner: string,
    repo: string,
    options: {
      name: string;
      headSha: string;
      status?: 'queued' | 'in_progress' | 'completed';
      conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required';
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
      status: options.status || 'queued',
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
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
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
      conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required';
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
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`[GitHub] Failed to update check run: ${error}`);
      // Don't throw - we don't want to break the build if check update fails
    }
  }

}
