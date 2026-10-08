import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InstanceConfigService } from '../../instance-config/instance-config.service';
import { SLACK_APP } from '../../instance-config/instance-config.sections';
import { LeaderElectionService } from '../../events/leader-election.service';
import { InstanceSettingsService } from '../../instance-settings/instance-settings.service';
import { SandboxWorkspaceService } from '../sandbox-workspace.service';
import {
  SandboxSessionsService,
  activityFromStatus,
  type SessionActivity
} from '../sandbox-sessions.service';
import { isWorktreePath } from '../sandbox-session-commands';
import { SlackClient } from './integration-clients';
import {
  diffstatLine,
  isSlackResponseUrl,
  sessionUrl,
  slackCommandText,
  stripSlackMentions,
  verifySlackSignature
} from './integration-helpers';
import { GreenhouseKickoffService } from './greenhouse-kickoff.service';
import { SlackLinkService } from './slack-link.service';

export interface SlackKickoffRequest {
  userId: string;
  slackUserId: string;
  channel: string;
  text: string;
  threadTs: string | null;
  responseUrl: string | null;
}

export type SlackLinkStep = 'expire' | 'mark-working' | 'complete' | 'wait';

const POLL_MS = 20_000;
const LINK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const IDLE_GRACE_MS = 90_000;
const STATUS_TIMEOUT_MS = 5_000;
const MAX_LINKS_PER_TICK = 100;
const SLACK_ID_RE = /^[A-Z0-9]{2,32}$/;
const SLACK_TS_RE = /^\d{1,12}\.\d{1,8}$/;
const USAGE =
  'Usage: `/greenhouse <what you want done>` (mention a repo as owner/name to pick one), `/greenhouse link` to connect your Orchard account, `/greenhouse unlink` to disconnect it.';

export function linkPrompt(url: string, unlinked: boolean): string {
  const lead = unlinked
    ? 'Your Slack account is not linked to Orchard yet.'
    : 'Connect your Slack account to Orchard.';
  return `${lead} Open this link while signed in to Orchard and confirm (it works once and expires in 10 minutes): ${url}`;
}

export function slackLinkStep(input: {
  sawWorking: boolean;
  ageMs: number;
  activity: SessionActivity | null;
}): SlackLinkStep {
  if (input.ageMs > LINK_MAX_AGE_MS) return 'expire';
  if (input.activity === null) return 'wait';
  if (input.activity === 'working') return input.sawWorking ? 'wait' : 'mark-working';
  if (input.sawWorking || input.ageMs > IDLE_GRACE_MS) return 'complete';
  return 'wait';
}

function link(url: string, label: string): string {
  return `<${url}|${label.replace(/[<>|]/g, '')}>`;
}

@Injectable()
export class SlackKickoffService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SlackKickoffService.name);

  private timer: ReturnType<typeof setInterval> | null = null;

  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: InstanceConfigService,
    private readonly kickoff: GreenhouseKickoffService,
    private readonly sessions: SandboxSessionsService,
    private readonly workspace: SandboxWorkspaceService,
    private readonly leader: LeaderElectionService,
    private readonly settings: InstanceSettingsService,
    private readonly links: SlackLinkService,
    @Inject(SlackClient) private readonly slack: SlackClient
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, POLL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  verify(rawBody: string, timestamp: string | undefined, signature: string | undefined): void {
    const ok = verifySlackSignature({
      secret: this.config.value(SLACK_APP, 'signingSecret'),
      timestamp,
      signature,
      rawBody
    });
    if (!ok) throw new UnauthorizedException('Invalid signature');
  }

  private botToken(): string | null {
    return this.config.value(SLACK_APP, 'botToken');
  }

  async handleCommand(input: {
    rawBody: string;
    timestamp: string | undefined;
    signature: string | undefined;
    body: any;
  }): Promise<Record<string, unknown>> {
    this.verify(input.rawBody, input.timestamp, input.signature);
    const body = input.body ?? {};
    if (body.ssl_check) return {};
    const text = slackCommandText(body.text);
    const teamId = String(body.team_id ?? '');
    const slackUserId = String(body.user_id ?? '');
    const channel = String(body.channel_id ?? '');
    if (!SLACK_ID_RE.test(teamId) || !SLACK_ID_RE.test(slackUserId) || !SLACK_ID_RE.test(channel)) {
      return { response_type: 'ephemeral', text: 'Slack did not say who sent this command.' };
    }
    const verb = text.toLowerCase();
    if (!text || verb === 'help') return { response_type: 'ephemeral', text: USAGE };
    if (verb === 'link') {
      const url = await this.links.createLink(teamId, slackUserId, Date.now(), {
        userName: body.user_name,
        teamDomain: body.team_domain
      });
      return { response_type: 'ephemeral', text: linkPrompt(url, false) };
    }
    if (verb === 'unlink') {
      const removed = await this.links.unlinkSlackIdentity(teamId, slackUserId);
      return {
        response_type: 'ephemeral',
        text: removed
          ? 'Your Slack account is no longer linked to Orchard.'
          : 'Your Slack account was not linked to Orchard.'
      };
    }
    const userId = await this.links.mappedUser(teamId, slackUserId);
    if (!userId) {
      const url = await this.links.createLink(teamId, slackUserId, Date.now(), {
        userName: body.user_name,
        teamDomain: body.team_domain
      });
      return { response_type: 'ephemeral', text: linkPrompt(url, true) };
    }
    const dedupe = typeof body.trigger_id === 'string' ? body.trigger_id : null;
    if (dedupe && !(await this.kickoff.claimDelivery('slack', `command:${dedupe}`))) {
      return { response_type: 'ephemeral', text: 'Already on it.' };
    }
    this.dispatch({
      userId,
      slackUserId,
      channel,
      text,
      threadTs: null,
      responseUrl: isSlackResponseUrl(body.response_url) ? body.response_url : null
    });
    return { response_type: 'ephemeral', text: 'Starting a Greenhouse session…' };
  }

  async handleEvent(input: {
    rawBody: string;
    timestamp: string | undefined;
    signature: string | undefined;
    body: any;
  }): Promise<Record<string, unknown>> {
    this.verify(input.rawBody, input.timestamp, input.signature);
    const body = input.body ?? {};
    if (body.type === 'url_verification') {
      return { challenge: typeof body.challenge === 'string' ? body.challenge : '' };
    }
    if (body.type !== 'event_callback') return { ok: true, ignored: 'not an event' };
    const appId = this.config.value(SLACK_APP, 'appId');
    if (appId && body.api_app_id && body.api_app_id !== appId) {
      return { ok: true, ignored: 'another app' };
    }
    const event = body.event ?? {};
    if (event.type !== 'app_mention') return { ok: true, ignored: 'not a mention' };
    if (event.bot_id || event.subtype || event.edited) return { ok: true, ignored: 'bot or edit' };
    const teamId = String(body.team_id ?? event.team ?? '');
    const slackUserId = String(event.user ?? '');
    const channel = String(event.channel ?? '');
    const ts = String(event.ts ?? '');
    if (
      !SLACK_ID_RE.test(teamId) ||
      !SLACK_ID_RE.test(slackUserId) ||
      !SLACK_ID_RE.test(channel) ||
      !SLACK_TS_RE.test(ts)
    ) {
      return { ok: true, ignored: 'incomplete event' };
    }
    const deliveryId = typeof body.event_id === 'string' ? body.event_id : `${channel}:${ts}`;
    if (!(await this.kickoff.claimDelivery('slack', deliveryId))) {
      return { ok: true, ignored: 'duplicate' };
    }
    const threadTs =
      typeof event.thread_ts === 'string' && SLACK_TS_RE.test(event.thread_ts)
        ? event.thread_ts
        : ts;
    const userId = await this.links.mappedUser(teamId, slackUserId);
    if (!userId) {
      this.later(() => this.sendLinkPrompt(teamId, slackUserId, channel, threadTs));
      return { ok: true, ignored: 'unlinked user' };
    }
    this.dispatch({
      userId,
      slackUserId,
      channel,
      text: stripSlackMentions(String(event.text ?? '')).slice(0, 32_000),
      threadTs,
      responseUrl: null
    });
    return { ok: true };
  }

  private later(work: () => Promise<void>): void {
    setImmediate(() => {
      void work().catch((e: any) =>
        this.logger.warn(`slack background work failed: ${e?.message}`)
      );
    });
  }

  dispatch(request: SlackKickoffRequest): void {
    this.later(() => this.run(request));
  }

  async sendLinkPrompt(
    teamId: string,
    slackUserId: string,
    channel: string,
    threadTs: string | null
  ): Promise<void> {
    const token = this.botToken();
    if (!token) return;
    const url = await this.links.createLink(teamId, slackUserId);
    await this.slack.postEphemeral(token, {
      channel,
      user: slackUserId,
      text: linkPrompt(url, true),
      threadTs
    });
  }

  async run(request: SlackKickoffRequest): Promise<void> {
    const token = this.botToken();
    if (!token) return;
    if (!request.text.trim()) {
      await this.say(token, request, USAGE);
      return;
    }
    const result = await this.kickoff.start({
      provider: 'slack',
      userId: request.userId,
      target: { kind: 'hint', text: request.text },
      prompt: request.text
    });
    if (result.kind === 'failed') {
      await this.say(token, request, `I could not start a Greenhouse session: ${result.reason}.`);
      return;
    }
    const message = `<@${request.slackUserId}> started ${link(result.url, result.session.title)} on ${result.sandbox.name} (${result.repo}). I will post here when the agent stops.`;
    const posted = await this.slack
      .postMessage(token, { channel: request.channel, text: message, threadTs: request.threadTs })
      .catch((e: any) => {
        this.logger.warn(`slack postMessage failed: ${e?.message}`);
        return null;
      });
    const threadTs = request.threadTs ?? posted?.ts ?? null;
    if (!posted && request.responseUrl) {
      await this.slack
        .respond(request.responseUrl, {
          response_type: 'ephemeral',
          text: `Started ${link(result.url, result.session.title)} on ${result.sandbox.name}. Invite the bot to this channel to get updates here.`
        })
        .catch(() => {});
    }
    if (!posted || !threadTs) return;
    await this.prisma.slackThreadLink.create({
      data: {
        sessionId: result.session.id,
        sandboxId: result.sandbox.id,
        userId: request.userId,
        channel: posted.channel,
        threadTs
      }
    });
  }

  private async say(token: string, request: SlackKickoffRequest, text: string): Promise<void> {
    if (request.responseUrl) {
      await this.slack
        .respond(request.responseUrl, { response_type: 'ephemeral', text })
        .catch(() => {});
      return;
    }
    await this.slack
      .postEphemeral(token, {
        channel: request.channel,
        user: request.slackUserId,
        text,
        threadTs: request.threadTs
      })
      .catch((e: any) => this.logger.warn(`slack reply failed: ${e?.message}`));
  }

  async tick(): Promise<void> {
    if (this.ticking || !this.leader.isLeader()) return;
    const token = this.botToken();
    if (!token) return;
    if (!(await this.settings.isSandboxesEnabled().catch(() => false))) return;
    this.ticking = true;
    try {
      await this.scan(token);
    } catch (e: any) {
      this.logger.warn(`slack thread scan failed: ${e?.message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async scan(token: string): Promise<void> {
    const links = await this.prisma.slackThreadLink.findMany({
      where: { completedAt: null },
      orderBy: { createdAt: 'asc' },
      take: MAX_LINKS_PER_TICK,
      include: {
        session: { select: { id: true, title: true, worktreePath: true, archivedAt: true } }
      }
    });
    const now = Date.now();
    for (const row of links) {
      const ageMs = now - row.createdAt.getTime();
      if (row.session.archivedAt || !isWorktreePath(row.session.worktreePath)) {
        await this.finish(row.id);
        continue;
      }
      const sandbox = await this.prisma.sandbox.findUnique({ where: { id: row.sandboxId } });
      if (!sandbox) {
        await this.finish(row.id);
        continue;
      }
      let activity: SessionActivity | null = null;
      if (sandbox.status === 'running') {
        try {
          const res = await this.workspace.opencodeRequest(sandbox, 'GET', '/session/status', {
            directory: row.session.worktreePath,
            timeoutMs: STATUS_TIMEOUT_MS
          });
          if (res.status === 200) activity = activityFromStatus(res.body);
        } catch {
          activity = null;
        }
      }
      const step = slackLinkStep({ sawWorking: row.sawWorking, ageMs, activity });
      if (step === 'expire') {
        await this.finish(row.id);
      } else if (step === 'mark-working') {
        await this.prisma.slackThreadLink.update({
          where: { id: row.id },
          data: { sawWorking: true }
        });
      } else if (step === 'complete') {
        const claimed = await this.prisma.slackThreadLink.updateMany({
          where: { id: row.id, completedAt: null },
          data: { completedAt: new Date() }
        });
        if (claimed.count === 0) continue;
        const dto = await this.sessions.get(sandbox, row.session.id).catch(() => null);
        const text = `${link(sessionUrl(sandbox.id, row.session.id), row.session.title)} is waiting for you: ${diffstatLine(dto?.diffstat)}.`;
        await this.slack
          .postMessage(token, { channel: row.channel, text, threadTs: row.threadTs })
          .catch((e: any) => this.logger.warn(`slack completion post failed: ${e?.message}`));
      }
    }
  }

  private async finish(id: string): Promise<void> {
    await this.prisma.slackThreadLink
      .update({ where: { id }, data: { completedAt: new Date() } })
      .catch(() => {});
  }
}
