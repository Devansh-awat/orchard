import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InstanceConfigService } from '../../instance-config/instance-config.service';
import { LINEAR } from '../../instance-config/instance-config.sections';
import { LinearClient } from './integration-clients';
import {
  issueContextFrom,
  parseGreenhouseCommand,
  verifyLinearSignature
} from './integration-helpers';
import { GreenhouseKickoffService } from './greenhouse-kickoff.service';
import {
  GreenhouseIssuesService,
  LINEAR_PROVIDER,
  linearIssueContext
} from './greenhouse-issues.service';

export interface LinearCommentCommand {
  deliveryId: string;
  commentId: string;
  parentId: string | null;
  issueId: string;
  issueTitle: string | null;
  issueIdentifier: string | null;
  issueUrl: string | null;
  actorId: string;
  instruction: string;
}

export type LinearClassification =
  | { kind: 'ignore'; reason: string }
  | { kind: 'command'; command: LinearCommentCommand };

export function classifyLinearComment(
  body: any,
  deliveryHeader: string | undefined
): LinearClassification {
  if (body?.type !== 'Comment' || body?.action !== 'create') {
    return { kind: 'ignore', reason: 'not a new comment' };
  }
  const data = body?.data ?? {};
  const actor = body?.actor ?? null;
  if ((actor?.type && actor.type !== 'user') || data.botActor || data.externalUserId) {
    return { kind: 'ignore', reason: 'comment from a bot' };
  }
  const parsed = parseGreenhouseCommand(data.body);
  if (!parsed) return { kind: 'ignore', reason: 'no /greenhouse command' };
  const issueId = typeof data.issueId === 'string' ? data.issueId : data.issue?.id;
  if (typeof issueId !== 'string' || !issueId) return { kind: 'ignore', reason: 'missing issue' };
  if (typeof data.id !== 'string') return { kind: 'ignore', reason: 'missing comment id' };
  const actorId =
    typeof actor?.id === 'string' ? actor.id : typeof data.userId === 'string' ? data.userId : null;
  if (!actorId) return { kind: 'ignore', reason: 'missing author' };
  return {
    kind: 'command',
    command: {
      deliveryId: deliveryHeader?.trim() || `comment:${data.id}`,
      commentId: data.id,
      parentId: typeof data.parentId === 'string' ? data.parentId : null,
      issueId,
      issueTitle: typeof data.issue?.title === 'string' ? data.issue.title : null,
      issueIdentifier: typeof data.issue?.identifier === 'string' ? data.issue.identifier : null,
      issueUrl: typeof data.issue?.url === 'string' ? data.issue.url : null,
      actorId,
      instruction: parsed.instruction
    }
  };
}

@Injectable()
export class LinearKickoffService {
  private readonly logger = new Logger(LinearKickoffService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: InstanceConfigService,
    private readonly kickoff: GreenhouseKickoffService,
    private readonly issues: GreenhouseIssuesService,
    @Inject(LinearClient) private readonly linear: LinearClient
  ) {}

  verify(rawBody: string, signature: string | undefined, body: any): void {
    const ok = verifyLinearSignature({
      secret: this.config.value(LINEAR, 'webhookSecret'),
      signature,
      rawBody,
      webhookTimestamp: body?.webhookTimestamp
    });
    if (!ok) throw new UnauthorizedException('Invalid signature');
  }

  async mapLinearUser(linearUserId: string | null | undefined): Promise<string | null> {
    if (!linearUserId) return null;
    const linked = await this.prisma.userIntegration.findFirst({
      where: { provider: LINEAR_PROVIDER, externalId: linearUserId },
      select: { userId: true }
    });
    return linked?.userId ?? null;
  }

  async handle(input: {
    rawBody: string;
    signature: string | undefined;
    delivery: string | undefined;
    body: unknown;
  }): Promise<Record<string, unknown>> {
    this.verify(input.rawBody, input.signature, input.body);
    const classified = classifyLinearComment(input.body, input.delivery);
    if (classified.kind === 'ignore') {
      return { received: true, action: 'ignored', reason: classified.reason };
    }
    const { command } = classified;
    if (!(await this.kickoff.claimDelivery('linear', command.deliveryId))) {
      return { received: true, action: 'ignored', reason: 'duplicate delivery' };
    }
    const userId = await this.mapLinearUser(command.actorId);
    if (!userId) {
      return { received: true, action: 'ignored', reason: 'author is not linked to Orchard' };
    }
    void this.run(userId, command).catch((e: any) =>
      this.logger.warn(`linear kickoff failed for ${command.deliveryId}: ${e?.message}`)
    );
    return { received: true, action: 'queued' };
  }

  async run(userId: string, command: LinearCommentCommand): Promise<void> {
    const key = await this.issues.linearKey(userId);
    if (!key) return;
    const fetched = await this.linear.issue(key, command.issueId).catch(() => null);
    const issue = fetched
      ? linearIssueContext(fetched)
      : issueContextFrom({
          provider: 'linear',
          ref: command.issueIdentifier ?? command.issueId,
          title: command.issueTitle ?? 'Linear issue',
          url: command.issueUrl
        });
    const hint = [command.instruction, fetched?.title ?? command.issueTitle]
      .filter(Boolean)
      .join('\n');
    const result = await this.kickoff.start({
      provider: 'linear',
      userId,
      target: { kind: 'hint', text: hint },
      prompt: command.instruction,
      issue,
      contentAuthorUserId: await this.mapLinearUser(fetched?.creatorId)
    });
    const text =
      result.kind === 'started'
        ? `Started a Greenhouse session for this issue: ${result.url}`
        : `Could not start a Greenhouse session: ${result.reason}.`;
    await this.linear
      .comment(key, command.issueId, text, command.parentId ?? command.commentId)
      .catch((e: any) => this.logger.warn(`linear reply failed: ${e?.message}`));
  }
}
