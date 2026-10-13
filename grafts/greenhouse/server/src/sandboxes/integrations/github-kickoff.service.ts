import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { GitHubService } from '../../core/github.service';
import { GithubIssuesClient, toGithubIssue, type GithubIssue } from './integration-clients';
import { parseGreenhouseCommand } from './integration-helpers';
import { GreenhouseKickoffService } from './greenhouse-kickoff.service';
import { githubIssueContext } from './greenhouse-issues.service';

const GH_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export interface IssueCommentCommand {
  installationId: string;
  owner: string;
  repo: string;
  issue: GithubIssue;
  senderId: string;
  senderLogin: string;
  instruction: string;
  commentId: string | null;
}

export type IssueCommentClassification =
  | { kind: 'ignore'; reason: string }
  | { kind: 'command'; command: IssueCommentCommand };

function isBot(user: any): boolean {
  if (!user) return true;
  if (user.type === 'Bot') return true;
  return typeof user.login === 'string' && user.login.endsWith('[bot]');
}

export function classifyIssueComment(body: any): IssueCommentClassification {
  if (body?.action !== 'created') return { kind: 'ignore', reason: 'not a new comment' };
  const installationId = body?.installation?.id;
  if (!installationId) return { kind: 'ignore', reason: 'missing installation context' };
  if (isBot(body?.sender) || isBot(body?.comment?.user)) {
    return { kind: 'ignore', reason: 'comment from a bot' };
  }
  if (body?.issue?.pull_request) return { kind: 'ignore', reason: 'pull request comment' };
  const parsed = parseGreenhouseCommand(body?.comment?.body);
  if (!parsed) return { kind: 'ignore', reason: 'no /greenhouse command' };
  const fullName = String(body?.repository?.full_name ?? '');
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo || !GH_NAME_RE.test(owner) || !GH_NAME_RE.test(repo)) {
    return { kind: 'ignore', reason: 'missing repository' };
  }
  const issue = toGithubIssue(body?.issue);
  if (!issue) return { kind: 'ignore', reason: 'missing issue' };
  const senderId = body?.sender?.id ?? body?.comment?.user?.id;
  if (senderId === undefined || senderId === null) {
    return { kind: 'ignore', reason: 'missing sender' };
  }
  if (body?.comment?.user?.id !== undefined && String(body.comment.user.id) !== String(senderId)) {
    return { kind: 'ignore', reason: 'sender is not the comment author' };
  }
  return {
    kind: 'command',
    command: {
      installationId: String(installationId),
      owner,
      repo,
      issue,
      senderId: String(senderId),
      senderLogin: String(body?.sender?.login ?? body?.comment?.user?.login ?? ''),
      instruction: parsed.instruction,
      commentId:
        body?.comment?.id !== undefined && body?.comment?.id !== null
          ? String(body.comment.id)
          : null
    }
  };
}

@Injectable()
export class GithubKickoffService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GithubKickoffService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GitHubService,
    private readonly kickoff: GreenhouseKickoffService,
    @Inject(GithubIssuesClient) private readonly issues: GithubIssuesClient
  ) {}

  onModuleInit() {
    this.github.setIssueCommentHandler((deliveryId, body) => this.handle(deliveryId, body));
  }

  onModuleDestroy() {
    this.github.setIssueCommentHandler(null);
  }

  async handle(deliveryId: string | undefined, body: unknown): Promise<Record<string, unknown>> {
    const classified = classifyIssueComment(body);
    if (classified.kind === 'ignore') {
      return { received: true, action: 'ignored', reason: classified.reason };
    }
    if (!deliveryId) return { received: true, action: 'ignored', reason: 'missing delivery id' };
    if (!(await this.kickoff.claimDelivery('github', deliveryId))) {
      return { received: true, action: 'ignored', reason: 'duplicate delivery' };
    }
    const { command } = classified;
    if (
      command.commentId &&
      !(await this.kickoff.claimDelivery('github', `comment:${command.commentId}`))
    ) {
      return { received: true, action: 'ignored', reason: 'duplicate comment' };
    }
    const user = await this.prisma.user.findUnique({
      where: { githubId: command.senderId },
      select: { id: true }
    });
    if (!user) {
      this.logger.log(`ignoring /greenhouse from unlinked GitHub user ${command.senderId}`);
      return { received: true, action: 'ignored', reason: 'commenter is not linked to Orchard' };
    }
    void this.run(user.id, command).catch((e: any) =>
      this.logger.warn(`github kickoff failed for delivery ${deliveryId}: ${e?.message}`)
    );
    return { received: true, action: 'queued' };
  }

  async run(userId: string, command: IssueCommentCommand): Promise<void> {
    const author = command.issue.authorId
      ? await this.prisma.user.findUnique({
          where: { githubId: command.issue.authorId },
          select: { id: true }
        })
      : null;
    const result = await this.kickoff.start({
      provider: 'github',
      userId,
      target: { kind: 'repo', owner: command.owner, repo: command.repo },
      prompt: command.instruction,
      issue: githubIssueContext(command.owner, command.repo, command.issue),
      contentAuthorUserId: author?.id ?? null
    });
    if (result.kind !== 'started') {
      this.logger.warn(
        `github kickoff for ${command.owner}/${command.repo}#${command.issue.number} failed: ${result.reason}`
      );
    }
    const mention = command.senderLogin ? `@${command.senderLogin} ` : '';
    const text =
      result.kind === 'started'
        ? `${mention}started a Greenhouse session for this issue: ${result.url}`
        : `${mention}I could not start a Greenhouse session for this issue. Open Greenhouse in Orchard to see why.`;
    await this.reply(command, text);
  }

  private async reply(command: IssueCommentCommand, text: string): Promise<void> {
    const token = await this.github.getOrRefreshInstallationToken(BigInt(command.installationId));
    await this.issues.comment(token, command.owner, command.repo, command.issue.number, text);
  }
}
