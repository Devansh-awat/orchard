import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma.service';
import { SecretCryptoService } from '../../core/secret-crypto.service';
import { GitHubService } from '../../core/github.service';
import { SandboxSessionsService, parseIssueRef } from '../sandbox-sessions.service';
import type { WorkspaceSandbox } from '../sandbox-workspace.service';
import { isValidRepoName } from '../sandbox-session-commands';
import { SandboxAccessService } from '../sandbox-access.service';
import { issueAuthorRefusal } from './greenhouse-kickoff.service';
import {
  GithubIssuesClient,
  IntegrationApiError,
  LinearClient,
  type GithubIssue,
  type LinearIssue
} from './integration-clients';
import {
  issueContextFrom,
  linearSlugHint,
  parseLinearRef,
  type IssueContext
} from './integration-helpers';

export const LINEAR_PROVIDER = 'linear';

export interface IssueSummaryDto {
  provider: 'github' | 'linear';
  ref: string;
  title: string;
  url: string | null;
  labels: string[];
  state: string | null;
  updatedAt: string | null;
}

const MAX_KEY_LENGTH = 200;

export function githubIssueContext(
  owner: string,
  repo: string,
  issue: Pick<GithubIssue, 'number' | 'title' | 'body' | 'url' | 'labels'>
): IssueContext {
  return issueContextFrom({
    provider: 'github',
    ref: `${owner}/${repo}#${issue.number}`,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    labels: issue.labels,
    slugHint: `${issue.number}-${issue.title}`
  });
}

export function linearIssueContext(issue: LinearIssue): IssueContext {
  return issueContextFrom({
    provider: 'linear',
    ref: issue.identifier,
    title: issue.title,
    body: issue.description,
    url: issue.url,
    labels: issue.labels,
    slugHint: linearSlugHint(issue.branchName, issue.identifier, issue.title)
  });
}

function githubSummary(owner: string, repo: string, issue: GithubIssue): IssueSummaryDto {
  return {
    provider: 'github',
    ref: `${owner}/${repo}#${issue.number}`,
    title: issue.title,
    url: issue.url,
    labels: issue.labels,
    state: issue.state,
    updatedAt: issue.updatedAt
  };
}

function linearSummary(issue: LinearIssue): IssueSummaryDto {
  return {
    provider: 'linear',
    ref: issue.identifier,
    title: issue.title,
    url: issue.url,
    labels: issue.labels,
    state: issue.state,
    updatedAt: issue.updatedAt
  };
}

@Injectable()
export class GreenhouseIssuesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GreenhouseIssuesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService,
    private readonly github: GitHubService,
    private readonly sessions: SandboxSessionsService,
    private readonly access: SandboxAccessService,
    @Inject(LinearClient) private readonly linear: LinearClient,
    @Inject(GithubIssuesClient) private readonly githubIssues: GithubIssuesClient
  ) {}

  onModuleInit() {
    this.sessions.setIssueResolver((input) =>
      input.provider === 'linear'
        ? this.linearContext(input.sandbox, input.actorUserId, input.ref)
        : this.githubContext(input.sandbox, input.repo, input.actorUserId, input.ref)
    );
  }

  onModuleDestroy() {
    this.sessions.setIssueResolver(null);
  }

  async linearKey(userId: string): Promise<string | null> {
    const row = await this.prisma.userIntegration.findUnique({
      where: { userId_provider: { userId, provider: LINEAR_PROVIDER } },
      select: { secret: true }
    });
    if (!row?.secret) return null;
    try {
      return this.crypto.decrypt(row.secret) || null;
    } catch {
      return null;
    }
  }

  async linkedIntegrations(userId: string): Promise<{
    integrations: Array<{ provider: string; account: string | null; linkedAt: Date | null }>;
  }> {
    const [user, rows] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { githubId: true, githubUsername: true }
      }),
      this.prisma.userIntegration.findMany({
        where: { userId },
        orderBy: { provider: 'asc' },
        select: { provider: true, workspaceName: true, createdAt: true }
      })
    ]);
    return {
      integrations: [
        ...(user?.githubId
          ? [{ provider: 'github', account: user.githubUsername ?? null, linkedAt: null }]
          : []),
        ...rows.map((r) => ({
          provider: r.provider,
          account: r.workspaceName,
          linkedAt: r.createdAt
        }))
      ]
    };
  }

  async linearStatus(
    userId: string
  ): Promise<{ connected: boolean; workspaceName: string | null }> {
    const row = await this.prisma.userIntegration.findUnique({
      where: { userId_provider: { userId, provider: LINEAR_PROVIDER } },
      select: { workspaceName: true }
    });
    return { connected: !!row, workspaceName: row?.workspaceName ?? null };
  }

  async connectLinear(
    userId: string,
    apiKey: unknown
  ): Promise<{ connected: boolean; workspaceName: string | null }> {
    if (typeof apiKey !== 'string') throw new BadRequestException('apiKey must be a string');
    const key = apiKey.trim();
    if (!key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
      throw new BadRequestException('That does not look like a Linear API key');
    }
    let viewer;
    try {
      viewer = await this.linear.viewer(key);
    } catch (e) {
      if (e instanceof IntegrationApiError) throw new BadRequestException(e.message);
      throw new BadRequestException('Could not reach Linear to check the key');
    }
    const taken = await this.prisma.userIntegration.findFirst({
      where: { provider: LINEAR_PROVIDER, externalId: viewer.id, userId: { not: userId } },
      select: { id: true }
    });
    if (taken) {
      throw new ConflictException(
        'This Linear account is already connected to another Orchard user. Disconnect it there first.'
      );
    }
    const data = {
      secret: this.crypto.encrypt(key),
      externalId: viewer.id.slice(0, 255),
      workspaceName: viewer.organizationName?.slice(0, 255) ?? null
    };
    try {
      await this.prisma.userIntegration.upsert({
        where: { userId_provider: { userId, provider: LINEAR_PROVIDER } },
        create: { userId, provider: LINEAR_PROVIDER, ...data },
        update: data
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'This Linear account is already connected to another Orchard user.'
        );
      }
      throw e;
    }
    return { connected: true, workspaceName: data.workspaceName };
  }

  async disconnectLinear(userId: string): Promise<{ connected: false; workspaceName: null }> {
    await this.prisma.userIntegration.deleteMany({ where: { userId, provider: LINEAR_PROVIDER } });
    return { connected: false, workspaceName: null };
  }

  async linearIssues(
    userId: string,
    q: string | undefined
  ): Promise<{ connected: boolean; issues: IssueSummaryDto[] }> {
    const key = await this.linearKey(userId);
    if (!key) return { connected: false, issues: [] };
    const term = typeof q === 'string' ? q.trim() : '';
    try {
      const identifier = term ? parseLinearRef(term) : null;
      if (identifier) {
        const issue = await this.linear.issue(key, identifier);
        return { connected: true, issues: issue ? [linearSummary(issue)] : [] };
      }
      const issues = await this.linear.openIssues(key, term);
      return { connected: true, issues: issues.map(linearSummary) };
    } catch (e) {
      if (e instanceof IntegrationApiError) throw new BadRequestException(e.message);
      throw new BadRequestException('Could not reach Linear');
    }
  }

  async linearContext(
    sandbox: WorkspaceSandbox,
    userId: string,
    ref: string
  ): Promise<IssueContext | null> {
    const identifier = parseLinearRef(ref);
    if (!identifier) return null;
    const key = await this.linearKey(userId);
    if (!key) return null;
    const issue = await this.linear.issue(key, identifier);
    if (!issue) return null;
    const author = issue.creatorId
      ? await this.prisma.userIntegration.findFirst({
          where: { provider: LINEAR_PROVIDER, externalId: issue.creatorId },
          select: { userId: true }
        })
      : null;
    await this.assertAuthorAllowed(sandbox, userId, author?.userId ?? null);
    return linearIssueContext(issue);
  }

  async assertAuthorAllowed(
    sandbox: WorkspaceSandbox,
    userId: string,
    authorUserId: string | null
  ): Promise<void> {
    const refusal = await issueAuthorRefusal(this.access, sandbox.id, userId, authorUserId);
    if (refusal) throw new ForbiddenException(refusal.charAt(0).toUpperCase() + refusal.slice(1));
  }

  async githubTokenFor(
    userId: string,
    target: { owner: string; repo: string },
    sandboxRemote: { owner: string; repo: string } | null,
    hostId: string | null = null
  ): Promise<string | null> {
    const sameRepo =
      !!sandboxRemote &&
      sandboxRemote.owner.toLowerCase() === target.owner.toLowerCase() &&
      sandboxRemote.repo.toLowerCase() === target.repo.toLowerCase();
    if (sameRepo) {
      for (const candidate of [...new Set([userId, hostId].filter((id): id is string => !!id))]) {
        const allowed = await this.github
          .verifyUserCanAccessRepo(candidate, target.owner, target.repo)
          .catch(() => false);
        if (allowed) return this.github.resolveRepoToken(userId, target.owner, target.repo);
      }
    }
    return this.github.getValidUserToken(userId);
  }

  async githubContext(
    sandbox: WorkspaceSandbox,
    repo: string,
    userId: string,
    ref: string
  ): Promise<IssueContext | null> {
    const remote = await this.sessions.repoRemote(sandbox, repo);
    const parsed = parseIssueRef(ref, remote);
    if (!parsed) return null;
    const token = await this.githubTokenFor(userId, parsed, remote, sandbox.userId);
    if (!token) return null;
    const issue = await this.githubIssues.issue(token, parsed.owner, parsed.repo, parsed.number);
    if (!issue) return null;
    const author = issue.authorId
      ? await this.prisma.user.findUnique({
          where: { githubId: issue.authorId },
          select: { id: true }
        })
      : null;
    await this.assertAuthorAllowed(sandbox, userId, author?.id ?? null);
    return githubIssueContext(parsed.owner, parsed.repo, issue);
  }

  async githubIssuesFor(
    sandbox: WorkspaceSandbox,
    userId: string,
    repo: unknown,
    q: string | undefined
  ): Promise<{ repo: string | null; issues: IssueSummaryDto[] }> {
    if (!isValidRepoName(repo)) throw new BadRequestException('Invalid repo name');
    if (sandbox.status !== 'running') {
      throw new BadRequestException('Start the machine to browse its issues');
    }
    const remote = await this.sessions.repoRemote(sandbox, repo);
    if (!remote) return { repo: null, issues: [] };
    const token = await this.githubTokenFor(userId, remote, remote, sandbox.userId);
    if (!token) {
      throw new BadRequestException('Link your GitHub account to browse issues');
    }
    const issues = await this.githubIssues
      .openIssues(token, remote.owner, remote.repo, typeof q === 'string' ? q : '')
      .catch((e: any) => {
        this.logger.warn(
          `github issue list failed for ${remote.owner}/${remote.repo}: ${e?.message}`
        );
        return [] as GithubIssue[];
      });
    return {
      repo: `${remote.owner}/${remote.repo}`,
      issues: issues.map((i) => githubSummary(remote.owner, remote.repo, i))
    };
  }
}
