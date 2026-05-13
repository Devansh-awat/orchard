import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OAuthService } from '../auth/oauth.service';
import * as crypto from 'crypto';

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
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly repoCache = new Map<string, CachedRepos>();
  private readonly CACHE_TTL = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauthService: OAuthService,
  ) {
    this.clientId = process.env.GITHUB_CLIENT_ID;
    this.clientSecret = process.env.GITHUB_CLIENT_SECRET;

    if (!this.clientId || !this.clientSecret) {
      console.warn('GitHub OAuth not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.');
    }
  }

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

  async getUserRepositories(accessToken: string, maxPages: number = 3): Promise<GitHubRepo[]> {
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

  async getRepoBranches(accessToken: string, owner: string, repo: string): Promise<GitHubBranch[]> {
    const MAX_PAGES = 10;
    const fetchPage = async (page: number): Promise<GitHubBranch[]> => {
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100&page=${page}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
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

  async getRepoContents(
    accessToken: string,
    owner: string,
    repo: string,
    path: string = '',
    branch?: string
  ): Promise<GitHubContent[]> {
    let url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    
    if (branch) {
      url += `?ref=${encodeURIComponent(branch)}`;
    }

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      throw new BadRequestException('Failed to fetch repository contents');
    }

    return await response.json();
  }

  async findDockerfiles(
    accessToken: string,
    owner: string,
    repo: string,
    branch?: string
  ): Promise<string[]> {
    // Use Git Trees API with recursive flag - single API call for entire repo
    const ref = branch || 'HEAD';
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;

    try {
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (!response.ok) {
        // Fallback to root-only scan if tree API fails
        return this.findDockerfilesFallback(accessToken, owner, repo, branch);
      }

      const tree = await response.json();
      const dockerfiles: string[] = [];

      for (const item of tree.tree) {
        if (item.type !== 'blob') continue;
        // Skip node_modules and .git paths
        if (item.path.includes('node_modules/') || item.path.includes('.git/')) continue;

        const fileName = item.path.split('/').pop()?.toLowerCase() ?? '';
        if (fileName === 'dockerfile' || fileName.startsWith('dockerfile.')) {
          dockerfiles.push(item.path);
        }
      }

      return dockerfiles;
    } catch (error) {
      console.error('Git tree API failed, falling back:', error.message);
      return this.findDockerfilesFallback(accessToken, owner, repo, branch);
    }
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
    let url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    
    if (branch) {
      url += `?ref=${encodeURIComponent(branch)}`;
    }

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

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

    const expectedSignature = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

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
      `https://api.github.com/repos/${owner}/${repo}/hooks`,
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
            secret: secret,
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
      `https://api.github.com/repos/${owner}/${repo}/hooks/${webhookId}`,
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
    environment: string = 'production',
    description?: string
  ): Promise<GitHubDeploymentResponse> {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/deployments`,
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
      `https://api.github.com/repos/${owner}/${repo}/deployments/${deploymentId}/statuses`,
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
      `https://api.github.com/repos/${owner}/${repo}/commits/${ref}`,
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
    const httpsMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }

    const sshMatch = repoUrl.match(/github\.com:([^\/]+)\/([^\/\.]+)/);
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
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!appId || !privateKey) {
      throw new BadRequestException('GitHub App not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.');
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

    // Update the cached token
    await this.prisma.gitHubAppInstallation.update({
      where: { installationId },
      data: {
        accessToken: token,
        tokenExpiresAt: expiresAt,
      },
    });

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
      // Find the user by their GitHub ID
      const user = await this.prisma.user.findFirst({
        where: { githubId: String(sender.id) },
      });

      if (!user) {
        console.warn(`[GitHub App] No user found with GitHub ID ${sender.id} (${sender.login})`);
        return;
      }

      // Create or update the installation record
      await this.prisma.gitHubAppInstallation.upsert({
        where: { installationId: BigInt(installation.id) },
        create: {
          userId: user.id,
          installationId: BigInt(installation.id),
          accountLogin: installation.account.login,
          accountId: BigInt(installation.account.id),
          accountType: installation.account.type,
          repositorySelection: installation.repository_selection,
        },
        update: {
          userId: user.id,
          accountLogin: installation.account.login,
          accountId: BigInt(installation.account.id),
          accountType: installation.account.type,
          repositorySelection: installation.repository_selection,
          suspendedAt: null,
        },
      });

      console.log(`[GitHub App] Installation created for user ${user.username}`);
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
      `https://api.github.com/repos/${owner}/${repo}`,
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
    const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
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
        OR: [
          { accountLogin: owner },
          { repositorySelection: 'all' },
        ],
        suspendedAt: null,
      },
    });

    // Check each installation for repo access
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
        // Token might be invalid, continue checking others
        console.warn(`[GitHub App] Failed to check repo access for installation ${installation.installationId}:`, e);
      }
    }

    return null;
  }

  // Create GitHub deployment using app installation token
  async createGitHubDeploymentWithApp(
    installationId: bigint,
    owner: string,
    repo: string,
    ref: string,
    environment: string = 'production',
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

  // Verify that a specific user (by stored OAuth token) can access a given repo on GitHub.
  // Uses the user-to-server token: GitHub returns 200 only if the user can see the repo.
  // Returns false if no token, repo not found, or any non-OK response.
  async verifyUserCanAccessRepo(userId: string, owner: string, repo: string): Promise<boolean> {
    const token = await this.getValidUserToken(userId);
    if (!token) return false;

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
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

  // List repositories the user can access within a specific installation (intersection
  // of installation repos and the user's GitHub permissions). Requires user OAuth token.
  async getUserAccessibleInstallationRepos(userToken: string, installationId: bigint): Promise<GitHubRepo[]> {
    const repos: GitHubRepo[] = [];
    let page = 1;
    const perPage = 100;
    while (page <= 10) {
      const response = await fetch(
        `https://api.github.com/user/installations/${installationId}/repositories?per_page=${perPage}&page=${page}`,
        {
          headers: {
            'Authorization': `Bearer ${userToken}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );
      if (!response.ok) {
        if (response.status === 404) return repos;
        throw new BadRequestException(`Failed to get user-accessible installation repos: ${await response.text()}`);
      }
      const data = await response.json();
      repos.push(...(data.repositories || []));
      if ((data.repositories || []).length < perPage) break;
      page++;
    }
    return repos;
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

  // Get all repos accessible to a user across all their installations, intersected with the
  // repos the user can see on GitHub (via their user OAuth token). Without a user token we
  // cannot verify access, so we return no repos — the user must link their GitHub identity.
  async getAllUserRepositories(userId: string): Promise<{ repos: GitHubRepo[]; installations: any[]; hasInstallations: boolean; userLinked: boolean }> {
    const userToken = await this.getValidUserToken(userId);

    const installations = await this.getUserInstallations(userId);
    const allRepos: GitHubRepo[] = [];
    const installationData: any[] = [];

    if (!userToken) {
      // No way to verify what the user themselves can access — surface installations only.
      for (const installation of installations) {
        installationData.push({
          id: installation.id,
          installationId: installation.installationId.toString(),
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
          repositoryCount: 0,
        });
      }
      return { repos: [], installations: installationData, hasInstallations: installations.length > 0, userLinked: false };
    }

    for (const installation of installations) {
      try {
        const repos = await this.getUserAccessibleInstallationRepos(userToken, installation.installationId);
        installationData.push({
          id: installation.id,
          installationId: installation.installationId.toString(),
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
          repositoryCount: repos.length,
        });
        for (const repo of repos) {
          allRepos.push({
            ...repo,
            installationId: installation.installationId.toString(),
            accountLogin: installation.accountLogin,
          } as any);
        }
      } catch (e) {
        console.error(`[GitHub] Failed to get user-accessible repos for installation ${installation.installationId}:`, e);
      }
    }

    return { repos: allRepos, installations: installationData, hasInstallations: installations.length > 0, userLinked: true };
  }

  // Get user's GitHub App installations
  async getUserInstallations(userId: string) {
    return this.prisma.gitHubAppInstallation.findMany({
      where: { userId, suspendedAt: null },
      orderBy: { accountLogin: 'asc' },
    });
  }

  // Get GitHub App installation URL
  getAppInstallationUrl(): string {
    const appSlug = process.env.GITHUB_APP_SLUG;
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
      `https://api.github.com/repos/${owner}/${repo}/check-runs`,
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
      `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}`,
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

  // Format build logs for GitHub check output (GitHub has a 65535 char limit for text)
  formatLogsForCheck(logs: string, maxLength: number = 60000): string {
    if (!logs) return '';

    // GitHub uses markdown for check output
    let formatted = '```\n' + logs + '\n```';

    if (formatted.length > maxLength) {
      const truncated = logs.substring(logs.length - (maxLength - 100));
      formatted = '```\n... (truncated, showing last portion)\n\n' + truncated + '\n```';
    }

    return formatted;
  }
}

