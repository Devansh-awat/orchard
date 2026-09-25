import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { GitHubService } from '../github/github.service';
import { detectApps, primaryApp, type DetectedApp } from '../github/framework-detect';
import { parseRepoUrl } from '../docker/repo-url';
import { encodeCloneCredential } from './clone-credential';
import {
  GIT_PROVIDER_KINDS,
  PROVIDER_DEFAULT_BASE_URL,
  hostOf,
  normalizeBaseUrl,
  type BranchRef,
  type ConnectionConfig,
  type GitProvider,
  type GitProviderKind,
  type RepoRef
} from './git-provider';
import { providerFor } from './providers';
import {
  GitOauthService,
  needsRefresh,
  type OauthIdentity,
  type OauthTokens,
  type OauthProvider
} from './git-oauth.service';

export interface GitConnectionInput {
  provider?: string;
  name?: string;
  baseUrl?: string | null;
  username?: string | null;
  token?: string | null;
}

export interface GitConnectionView {
  id: string;
  provider: GitProviderKind;
  name: string;
  baseUrl: string;
  host: string;
  username: string | null;
  canList: boolean;
  webhookPath: string;
  oauth: boolean;
  dependents: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RepoDetection {
  buildType: 'dockerfile' | 'railpack';
  dockerfilePath: string | null;
  dockerfiles: string[];
  stages: string[];
  ports: number[];
  env: { key: string; value: string }[];
  framework: string | null;
  apps: DetectedApp[];
  rootDirectory: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;

@Injectable()
export class GitConnectionsService {
  private readonly logger = new Logger(GitConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: SecretCryptoService,
    private readonly github: GitHubService,
    private readonly oauth: GitOauthService
  ) {}

  private view(row: {
    id: string;
    provider: string;
    name: string;
    baseUrl: string;
    username: string | null;
    oauth: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): GitConnectionView {
    return {
      id: row.id,
      provider: row.provider as GitProviderKind,
      name: row.name,
      baseUrl: row.baseUrl,
      host: hostOf(row.baseUrl),
      username: row.username,
      canList: row.provider !== 'generic',
      webhookPath: `/apiv1/git/webhooks/${row.id}`,
      oauth: row.oauth,
      dependents: 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  private async rowOrThrow(userId: string, connectionId: string) {
    const row = await this.prisma.gitConnection.findUnique({ where: { id: connectionId } });
    if (!row || row.userId !== userId) {
      throw new NotFoundException('Git connection not found');
    }
    return row;
  }

  configFor(row: {
    provider: string;
    baseUrl: string;
    username: string | null;
    token: string;
    webhookSecret: string;
  }): ConnectionConfig {
    return {
      kind: row.provider as GitProviderKind,
      baseUrl: row.baseUrl,
      username: row.username,
      token: this.crypto.decrypt(row.token),
      webhookSecret: row.webhookSecret
    };
  }

  /**
   * An OAuth token is short-lived, so it is refreshed here, at the last
   * moment before it is used, and the new pair is written back. A pasted
   * token is used as is.
   */
  async providerForRow(row: {
    id: string;
    provider: string;
    baseUrl: string;
    username: string | null;
    token: string;
    webhookSecret: string;
    oauth: boolean;
    refreshToken: string | null;
    tokenExpiresAt: Date | null;
  }): Promise<GitProvider> {
    if (row.oauth && row.refreshToken && needsRefresh(row.tokenExpiresAt)) {
      const fresh = await this.oauth.refresh(
        row.provider as OauthProvider,
        this.crypto.decrypt(row.refreshToken)
      );
      const updated = await this.prisma.gitConnection.update({
        where: { id: row.id },
        data: {
          token: this.crypto.encrypt(fresh.accessToken),
          refreshToken: fresh.refreshToken
            ? this.crypto.encrypt(fresh.refreshToken)
            : row.refreshToken,
          tokenExpiresAt: fresh.expiresAt
        }
      });
      return providerFor(this.configFor(updated));
    }
    return providerFor(this.configFor(row));
  }

  oauthAvailable() {
    return this.oauth.available();
  }

  /** One connection per person per OAuth forge; linking again just refreshes it. */
  async upsertOauth(
    userId: string,
    provider: OauthProvider,
    tokens: OauthTokens,
    identity: OauthIdentity
  ): Promise<GitConnectionView> {
    const label = provider === 'gitlab' ? 'GitLab' : 'Bitbucket';
    const existing = await this.prisma.gitConnection.findFirst({
      where: { userId, provider, oauth: true, baseUrl: identity.baseUrl }
    });
    const data = {
      name: `${label} (${identity.username})`,
      username: provider === 'bitbucket' ? null : identity.username,
      token: this.crypto.encrypt(tokens.accessToken),
      refreshToken: tokens.refreshToken ? this.crypto.encrypt(tokens.refreshToken) : null,
      tokenExpiresAt: tokens.expiresAt
    };
    const row = existing
      ? await this.prisma.gitConnection.update({ where: { id: existing.id }, data })
      : await this.prisma.gitConnection.create({
          data: {
            ...data,
            userId,
            provider,
            baseUrl: identity.baseUrl,
            oauth: true,
            webhookSecret: randomBytes(32).toString('hex')
          }
        });
    void this.audit.log({
      action: existing ? 'git.connection.updated' : 'git.connection.created',
      actorUserId: userId,
      targetType: 'git_connection',
      targetId: row.id,
      targetLabel: row.name,
      metadata: { provider, host: hostOf(row.baseUrl), oauth: true }
    });
    return this.view(row);
  }

  async list(userId: string): Promise<GitConnectionView[]> {
    const rows = await this.prisma.gitConnection.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { deployments: true } } }
    });
    return rows.map((r) => ({ ...this.view(r), dependents: r._count.deployments }));
  }

  async get(userId: string, connectionId: string): Promise<GitConnectionView> {
    return this.view(await this.rowOrThrow(userId, connectionId));
  }

  async webhookSecret(userId: string, connectionId: string): Promise<string> {
    return (await this.rowOrThrow(userId, connectionId)).webhookSecret;
  }

  async create(userId: string, input: GitConnectionInput): Promise<GitConnectionView> {
    const provider = String(input.provider || '').trim() as GitProviderKind;
    if (!GIT_PROVIDER_KINDS.includes(provider)) {
      throw new BadRequestException(`provider must be one of ${GIT_PROVIDER_KINDS.join(', ')}`);
    }
    const name = String(input.name || '').trim();
    if (!NAME_RE.test(name)) throw new BadRequestException('Give the connection a short name');
    const baseUrl = normalizeBaseUrl(
      String(input.baseUrl || PROVIDER_DEFAULT_BASE_URL[provider] || '')
    );
    if (!baseUrl) throw new BadRequestException('Base URL must be a plain https:// address');
    const token = String(input.token || '').trim();
    if (!token) throw new BadRequestException('A token is required');
    if (token.length > 4096) throw new BadRequestException('Token is too long');
    const username = String(input.username || '').trim() || null;
    if (provider === 'bitbucket' && !username) {
      throw new BadRequestException('Bitbucket needs the username the app password belongs to');
    }
    const existing = await this.prisma.gitConnection.findFirst({
      where: { userId, name },
      select: { id: true }
    });
    if (existing) throw new BadRequestException(`${name} is already used by another connection`);

    const config: ConnectionConfig = {
      kind: provider,
      baseUrl,
      username,
      token,
      webhookSecret: ''
    };
    await this.probe(config);

    const row = await this.prisma.gitConnection.create({
      data: {
        userId,
        provider,
        name,
        baseUrl,
        username,
        token: this.crypto.encrypt(token),
        webhookSecret: randomBytes(32).toString('hex')
      }
    });
    void this.audit.log({
      action: 'git.connection.created',
      actorUserId: userId,
      targetType: 'git_connection',
      targetId: row.id,
      targetLabel: row.name,
      metadata: { provider, host: hostOf(baseUrl) }
    });
    return this.view(row);
  }

  /**
   * A bad token should fail here, with the person watching, not at the
   * first build. Generic hosts have no API to ask, so they are taken on
   * trust and fail loudly at clone time instead.
   */
  private async probe(config: ConnectionConfig): Promise<void> {
    if (config.kind === 'generic') return;
    try {
      await providerFor(config).listRepos();
    } catch (e) {
      throw new BadRequestException(
        `${hostOf(config.baseUrl)} rejected the token: ${(e as Error).message}`
      );
    }
  }

  async update(
    userId: string,
    connectionId: string,
    input: GitConnectionInput
  ): Promise<GitConnectionView> {
    const row = await this.rowOrThrow(userId, connectionId);
    const data: { name?: string; token?: string; username?: string | null } = {};
    if (input.name !== undefined) {
      const name = String(input.name || '').trim();
      if (!NAME_RE.test(name)) throw new BadRequestException('Give the connection a short name');
      data.name = name;
    }
    if (input.username !== undefined) data.username = String(input.username || '').trim() || null;
    if (input.token) {
      const token = String(input.token).trim();
      await this.probe({
        ...this.configFor(row),
        token,
        username: data.username ?? row.username
      });
      data.token = this.crypto.encrypt(token);
    }
    const updated = await this.prisma.gitConnection.update({ where: { id: row.id }, data });
    void this.audit.log({
      action: 'git.connection.updated',
      actorUserId: userId,
      targetType: 'git_connection',
      targetId: row.id,
      targetLabel: updated.name,
      metadata: { tokenRotated: Boolean(input.token) }
    });
    return this.view(updated);
  }

  async remove(userId: string, connectionId: string): Promise<void> {
    const row = await this.rowOrThrow(userId, connectionId);
    const inUse = await this.prisma.deployment.count({ where: { gitConnectionId: row.id } });
    if (inUse > 0) {
      throw new BadRequestException(
        `${row.name} is still the source of ${inUse} app${inUse === 1 ? '' : 's'}. Point them elsewhere first.`
      );
    }
    await this.prisma.gitConnection.delete({ where: { id: row.id } });
    void this.audit.log({
      action: 'git.connection.removed',
      actorUserId: userId,
      targetType: 'git_connection',
      targetId: row.id,
      targetLabel: row.name
    });
  }

  async repos(userId: string, connectionId: string): Promise<RepoRef[]> {
    const row = await this.rowOrThrow(userId, connectionId);
    return (await this.providerForRow(row)).listRepos();
  }

  async branches(userId: string, connectionId: string, repo: string): Promise<BranchRef[]> {
    const row = await this.rowOrThrow(userId, connectionId);
    return (await this.providerForRow(row)).listBranches(this.repoArg(repo));
  }

  private repoArg(repo: string): string {
    const clean = String(repo || '')
      .trim()
      .replace(/^\/+|\/+$/g, '');
    if (!clean || clean.includes('..')) throw new BadRequestException('repo is required');
    return clean;
  }

  /** `owner/name` for a repo URL on this connection's host, else null. */
  repoPathFor(baseUrl: string, repoUrl: string): string | null {
    const parsed = parseRepoUrl(repoUrl);
    if (!parsed || parsed.host !== hostOf(baseUrl)) return null;
    const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
    const path = parsed.pathname.replace(/\.git$/, '').replace(/\/+$/, '');
    if (basePath && !path.startsWith(`${basePath}/`)) return null;
    const rel = (basePath ? path.slice(basePath.length) : path).replace(/^\/+/, '');
    return rel.includes('/') ? rel : null;
  }

  async detect(
    userId: string,
    connectionId: string,
    repo: string,
    branch: string
  ): Promise<RepoDetection> {
    const row = await this.rowOrThrow(userId, connectionId);
    const provider = await this.providerForRow(row);
    const repoPath = this.repoArg(repo);
    const ref = String(branch || '').trim() || (await provider.defaultBranch(repoPath)) || 'HEAD';
    const tree = await provider.listTree(repoPath, ref);
    const read = (path: string) => provider.readFile(repoPath, path, ref).catch(() => null);
    const empty = {
      apps: [] as DetectedApp[],
      rootDirectory: null,
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null
    };
    const dockerfiles = (tree ?? []).filter((p) => {
      if (p.includes('node_modules/') || p.includes('.git/')) return false;
      const file = p.split('/').pop()?.toLowerCase() ?? '';
      return file === 'dockerfile' || file.startsWith('dockerfile.');
    });
    if (dockerfiles.length > 0) {
      const dockerfilePath = [...dockerfiles].sort(
        (a, b) => a.split('/').length - b.split('/').length || a.length - b.length
      )[0];
      const content = (await read(dockerfilePath)) ?? '';
      return {
        buildType: 'dockerfile',
        dockerfilePath,
        dockerfiles,
        stages: this.github.parseDockerfileStages(content),
        ports: this.github.parseExposedPorts(content),
        env: this.github.parseEnvVars(content),
        framework: null,
        ...empty
      };
    }
    if (!tree) {
      return {
        buildType: 'railpack',
        dockerfilePath: null,
        dockerfiles: [],
        stages: [],
        ports: [3000],
        env: [{ key: 'PORT', value: '3000' }],
        framework: null,
        ...empty
      };
    }
    const { apps, repoConfig } = await detectApps(tree, read);
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
      apps,
      rootDirectory: primary?.dir || null,
      installCommand: primary?.installCommand ?? null,
      buildCommand: primary?.buildCommand ?? null,
      startCommand: primary?.startCommand ?? null,
      outputDirectory: primary?.outputDirectory ?? null
    };
  }

  /**
   * The clone credential for a deployment sourced from a connection, as the
   * opaque token the build pipeline already passes around. Null when the
   * deployment is not on a connection, so callers fall back to GitHub.
   */
  async cloneTokenForDeployment(deploymentId: string): Promise<string | null> {
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { gitConnection: true }
    });
    if (!dep?.gitConnection) return null;
    return encodeCloneCredential((await this.providerForRow(dep.gitConnection)).cloneCredential());
  }

  /** Resolve a connection an org member is allowed to deploy from. */
  async forDeploy(userId: string, connectionId: string) {
    return this.rowOrThrow(userId, connectionId);
  }
}
