import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException
} from '@nestjs/common';
import { Request } from 'express';
import { InstanceConfigService } from '../instance-config/instance-config.service';
import { TURNSTILE } from '../instance-config/instance-config.sections';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 5_000;

export const TURNSTILE_HEADER = 'x-turnstile-token';

export type TurnstileAction = 'signin' | 'protection';

interface SiteVerifyResponse {
  success?: boolean;
  action?: string;
  hostname?: string;
  'error-codes'?: string[];
}

const CHALLENGE_FAILED = 'Bot check failed. Reload the page and try again.';
const CHALLENGE_UNREACHABLE = 'Could not reach the bot check. Try again in a moment.';

@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);

  constructor(private readonly config: InstanceConfigService) {}

  isEnabled(): boolean {
    if (!this.config.isConfigured(TURNSTILE)) return false;
    return this.config.flag(TURNSTILE, 'enabled');
  }

  isStrict(): boolean {
    return this.config.flag(TURNSTILE, 'strict');
  }

  siteKey(): string | null {
    if (!this.isEnabled()) return null;
    return this.config.value(TURNSTILE, 'siteKey');
  }

  private async siteVerify(
    token: string,
    ip: string | null,
    action: TurnstileAction
  ): Promise<SiteVerifyResponse | null> {
    const unreachable = (reason: string) => {
      this.logger.error(`siteverify unreachable for ${action}: ${reason}`);
      return null;
    };

    const secret = this.config.value(TURNSTILE, 'secretKey');
    if (!secret) return unreachable('no secret key configured');

    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);

    let response: Response;
    try {
      response = await fetch(VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
      });
    } catch (e: any) {
      return unreachable(e?.message ?? String(e));
    }

    if (!response.ok) return unreachable(`siteverify returned ${response.status}`);

    try {
      return (await response.json()) as SiteVerifyResponse;
    } catch (e: any) {
      return unreachable(`unreadable body: ${e?.message ?? e}`);
    }
  }

  async verifyRequest(req: Request, action: TurnstileAction, ip: string | null): Promise<void> {
    if (!this.isEnabled()) return;

    const token = (req.headers[TURNSTILE_HEADER] ?? '').toString().trim();
    if (!token) throw new ForbiddenException(CHALLENGE_FAILED);

    const outcome = await this.siteVerify(token, ip, action);
    if (!outcome) {
      if (this.isStrict()) throw new ServiceUnavailableException(CHALLENGE_UNREACHABLE);
      this.logger.warn(`allowing ${action} unchallenged because the check could not be reached`);
      return;
    }

    if (!outcome.success) {
      const reason = (outcome['error-codes'] ?? []).join(', ') || 'no reason given';
      this.logger.warn(`challenge rejected for ${action}: ${reason}`);
      throw new ForbiddenException(CHALLENGE_FAILED);
    }

    if (outcome.action !== action) {
      this.logger.warn(`challenge solved for "${outcome.action ?? 'none'}", expected "${action}"`);
      throw new ForbiddenException(CHALLENGE_FAILED);
    }
  }
}
