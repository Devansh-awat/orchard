import { Injectable, Logger } from '@nestjs/common';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import { createHmac } from 'crypto';
import { EmailService } from '../email/email.service';
import {
  EVENT_TONE,
  EventTone,
  NotificationMessage,
  TONE_COLORS,
  isNotificationEvent
} from './notification-events';
import { assertSafeWebhookUrl, defaultPort, guardedLookup } from './webhook-guard';

const HTTP_TIMEOUT_MS = 10_000;

export interface TransportConfig {
  url?: string;
  recipients?: string[];
  secret?: string;
}

export interface TransportTarget {
  type: string;
  config: TransportConfig;
  label: string;
  organizationId?: string | null;
}

// The delivery worker needs to tell three cases apart: succeeded, failed but
// worth retrying, and failed for good (a deleted webhook will never heal, so
// retrying it just burns the queue). retryAfterMs carries what the server asked
// for, which always beats our own backoff curve.
export interface SendOutcome {
  ok: boolean;
  httpStatus?: number;
  retryAfterMs?: number;
  permanent?: boolean;
  error?: string;
}

@Injectable()
export class NotificationTransport {
  private readonly logger = new Logger(NotificationTransport.name);

  private readonly frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  constructor(private readonly email: EmailService) {}

  // One entry point for both lanes. A single message renders normally; several
  // render as a digest, which is how coalescing avoids dropping anything.
  async send(target: TransportTarget, messages: NotificationMessage[]): Promise<SendOutcome> {
    if (messages.length === 0) return { ok: true };
    try {
      switch (target.type) {
        case 'discord':
          return await this.sendDiscord(target, messages);
        case 'slack':
          return await this.sendSlack(target, messages);
        case 'webhook':
          return await this.sendWebhook(target, messages);
        case 'email':
          return await this.sendEmail(target, messages);
        default:
          return { ok: false, permanent: true, error: `Unknown destination type: ${target.type}` };
      }
    } catch (e: any) {
      return { ok: false, error: truncate(String(e?.message ?? e), 2000) };
    }
  }

  private async sendDiscord(
    target: TransportTarget,
    messages: NotificationMessage[]
  ): Promise<SendOutcome> {
    const embeds = messages.slice(0, 10).map((message) => ({
      title: truncate(message.title, 250),
      description: truncate(message.body, 2000),
      url: message.url,
      color: TONE_COLORS[toneOf(message)],
      fields: (message.fields ?? []).map((f) => ({
        name: truncate(f.name, 250),
        value: truncate(f.value, 1000),
        inline: true
      })),
      footer: {
        text: message.projectName ? `Orchard · ${truncate(message.projectName, 100)}` : 'Orchard'
      },
      timestamp: new Date().toISOString()
    }));
    return this.postJson(target.config.url, {
      allowed_mentions: { parse: [] },
      ...(messages.length > 1 ? { content: digestHeadline(messages) } : {}),
      embeds
    });
  }

  private async sendSlack(
    target: TransportTarget,
    messages: NotificationMessage[]
  ): Promise<SendOutcome> {
    const blocks: unknown[] = [];
    if (messages.length > 1) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${slackEscape(digestHeadline(messages))}*` }
      });
    }
    for (const message of messages.slice(0, 20)) {
      const title = slackEscape(truncate(message.title, 250));
      const body = slackEscape(truncate(message.body, 2000));
      const heading = message.url ? `<${message.url}|${title}>` : title;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${heading}*\n${body}` } });
      const context = [
        ...(message.projectName ? [`*Project:* ${slackEscape(message.projectName)}`] : []),
        ...(message.fields ?? []).map((f) => `*${slackEscape(f.name)}:* ${slackEscape(f.value)}`)
      ];
      if (context.length) {
        blocks.push({
          type: 'context',
          elements: context.map((text) => ({ type: 'mrkdwn', text }))
        });
      }
    }
    const first = messages[0];
    const fallback =
      messages.length > 1
        ? digestHeadline(messages)
        : `${slackEscape(truncate(first.title, 250))}: ${slackEscape(truncate(first.body, 2000))}`;
    return this.postJson(target.config.url, { text: fallback, blocks });
  }

  private async sendWebhook(
    target: TransportTarget,
    messages: NotificationMessage[]
  ): Promise<SendOutcome> {
    const render = (message: NotificationMessage) => ({
      event: message.event,
      title: message.title,
      body: message.body,
      url: message.url ?? null,
      organizationId: target.organizationId ?? null,
      projectId: message.projectId ?? null,
      projectName: message.projectName ?? null,
      targetId: message.targetId ?? null,
      targetName: message.targetName ?? null,
      fields: message.fields ?? []
    });
    const payload =
      messages.length > 1
        ? {
            batch: true,
            count: messages.length,
            events: messages.map(render),
            timestamp: new Date().toISOString()
          }
        : { ...render(messages[0]), timestamp: new Date().toISOString() };
    const raw = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'x-orchard-event': messages.length > 1 ? 'batch' : messages[0].event
    };
    if (target.config.secret) {
      const ts = Date.now().toString();
      headers['x-orchard-timestamp'] = ts;
      headers['x-orchard-signature'] = `sha256=${createHmac('sha256', target.config.secret)
        .update(`${ts}.${raw}`)
        .digest('hex')}`;
    }
    return this.postRaw(target.config.url, raw, headers);
  }

  private async sendEmail(
    target: TransportTarget,
    messages: NotificationMessage[]
  ): Promise<SendOutcome> {
    const recipients = (target.config.recipients ?? []).filter(Boolean);
    if (recipients.length === 0) {
      return { ok: false, permanent: true, error: 'No recipients configured' };
    }
    const digest = messages.length > 1;
    const first = messages[0];
    const subject = digest ? digestHeadline(messages) : first.title;
    const body = digest
      ? messages.map((m) => `• ${m.title}: ${truncate(m.body, 300)}`).join('\n')
      : first.body;
    const sent = await this.email.sendNotificationEmail({
      recipients,
      subject,
      title: subject,
      body,
      // Slack and Discord render the fields, and email has to as well: the one line
      // that says which device and which address must reach the destination most
      // people actually have turned on.
      contextLine: digest ? '' : detailLine(first),
      ctaUrl: (digest ? undefined : first.url) || this.frontendUrl
    });
    if (!sent) return { ok: false, error: "Email sending failed or SMTP isn't configured" };
    return { ok: true };
  }

  private async postJson(rawUrl: string | undefined, body: unknown): Promise<SendOutcome> {
    return this.postRaw(rawUrl, JSON.stringify(body), {});
  }

  // No inline retry loop here on purpose: retries are the delivery worker's job,
  // where they survive a process restart and honour the circuit breaker.
  private async postRaw(
    rawUrl: string | undefined,
    body: string,
    headers: Record<string, string>
  ): Promise<SendOutcome> {
    if (!rawUrl) return { ok: false, permanent: true, error: 'No webhook URL configured' };
    try {
      await assertSafeWebhookUrl(rawUrl);
    } catch (e: any) {
      return { ok: false, permanent: true, error: truncate(String(e?.message ?? e), 500) };
    }
    return this.post(rawUrl, body, headers);
  }

  private post(
    rawUrl: string,
    body: string,
    headers: Record<string, string>
  ): Promise<SendOutcome> {
    return new Promise((resolve) => {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        resolve({ ok: false, permanent: true, error: 'Invalid webhook URL' });
        return;
      }
      const isHttps = url.protocol === 'https:';
      const payload = Buffer.from(body);
      const req = (isHttps ? httpsRequest : httpRequest)(
        {
          hostname: url.hostname,
          port: url.port ? Number(url.port) : defaultPort(url.protocol),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': payload.length,
            'user-agent': 'Orchard-Notifications/2.0',
            ...headers
          },
          lookup: guardedLookup,
          timeout: HTTP_TIMEOUT_MS,
          agent: false
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            if (size < 2048) {
              chunks.push(c);
              size += c.length;
            }
          });
          res.on('end', () => {
            if (status >= 200 && status < 300) {
              resolve({ ok: true, httpStatus: status });
              return;
            }
            const snippet = truncate(Buffer.concat(chunks).toString('utf8'), 300);
            resolve({
              ok: false,
              httpStatus: status,
              retryAfterMs: retryAfterFrom(res.headers),
              permanent: isPermanentStatus(status),
              error: `HTTP ${status}${snippet ? `: ${snippet}` : ''}`
            });
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('Request timed out')));
      req.on('error', (e: any) =>
        resolve({ ok: false, error: truncate(String(e?.message ?? e), 500) })
      );
      req.end(payload);
    });
  }
}

// 4xx means we sent something the destination will never accept, with two
// exceptions: 408 is a timeout and 429 is explicitly "come back later".
function isPermanentStatus(status: number): boolean {
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

function retryAfterFrom(headers: Record<string, any>): number | undefined {
  const resetAfter = headers['x-ratelimit-reset-after'];
  if (resetAfter) {
    const seconds = Number(Array.isArray(resetAfter) ? resetAfter[0] : resetAfter);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(seconds * 1000, 6 * 60 * 60 * 1000);
  }
  const raw = headers['retry-after'];
  if (!raw) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 6 * 60 * 60 * 1000);
  const at = Date.parse(String(value));
  if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), 6 * 60 * 60 * 1000));
  return undefined;
}

function toneOf(message: NotificationMessage): EventTone {
  return isNotificationEvent(message.event) ? EVENT_TONE[message.event] : 'success';
}

function detailLine(message: NotificationMessage): string {
  if (message.projectName) return `Project: ${message.projectName}`;
  return (message.fields ?? [])
    .map((f) => f.value)
    .filter(Boolean)
    .join(' · ');
}

function digestHeadline(messages: NotificationMessage[]): string {
  const counts = new Map<string, number>();
  for (const m of messages) counts.set(m.event, (counts.get(m.event) ?? 0) + 1);
  const parts = [...counts.entries()].map(([event, n]) => `${n}× ${event}`);
  return `${messages.length} notifications: ${parts.join(', ')}`;
}

export function slackEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function truncate(value: string | null | undefined, max: number): string {
  if (!value) return '';
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
