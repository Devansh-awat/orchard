import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { GithubAppConfigService } from './github-app-config.service';

const STATE_KEY = 'github_app_manifest_state';
const STATE_TTL_MS = 15 * 60 * 1000;

interface StateRecord {
  value: string;
  expiresAt: string;
  /** Same-origin path to send the browser back to once the App exists. */
  returnTo?: string;
}

interface ManifestConversion {
  id: number;
  slug: string;
  pem: string;
  webhook_secret: string;
  client_id: string;
  client_secret: string;
}

@Injectable()
export class GithubAppSetupService {
  private readonly logger = new Logger(GithubAppSetupService.name);

  constructor(
    private readonly settings: InstanceSettingsService,
    private readonly config: GithubAppConfigService
  ) {}

  private frontendUrl(): string {
    return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  }

  async startManifestFlow(
    organization?: string,
    returnTo?: string
  ): Promise<{
    postUrl: string;
    manifest: string;
    state: string;
  }> {
    // Creating an App writes credentials the environment already pins, so the
    // flow is refused rather than run to completion against a config that can
    // never take effect. Same lock the setup page draws, enforced here so it
    // holds for every client.
    const locked = this.config.lockedFields();
    if (locked.length > 0) {
      throw new ConflictException(
        'The GitHub App is set by environment variables and cannot be replaced here'
      );
    }

    const base = this.frontendUrl();
    const host = new URL(base).hostname;

    const state = randomBytes(24).toString('base64url');
    const record: StateRecord = {
      value: state,
      expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString(),
      // Creating the App navigates the browser all the way to GitHub and back,
      // so where the operator came from has to survive the round trip or they
      // land on a page with no relation to what they were doing.
      returnTo:
        returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : undefined
    };
    await this.settings.set(STATE_KEY, JSON.stringify(record));

    const manifest = {
      name: `Orchard (${host})`,
      url: base,
      hook_attributes: { url: `${base}/apiv1/github/app/webhook`, active: true },
      redirect_url: `${base}/apiv1/setup/github-app/callback`,
      callback_urls: [this.config.callbackUrl()],
      public: false,
      default_permissions: {
        contents: 'read',
        metadata: 'read'
      },
      default_events: ['push', 'repository']
    };

    const postUrl = organization
      ? `https://github.com/organizations/${organization}/settings/apps/new`
      : 'https://github.com/settings/apps/new';

    return { postUrl, manifest: JSON.stringify(manifest), state };
  }

  private async consumeState(supplied: string): Promise<string | undefined> {
    const raw = await this.settings.get(STATE_KEY);
    await this.settings.delete(STATE_KEY);

    if (!raw) throw new BadRequestException('No App creation is in progress');

    let record: StateRecord;
    try {
      record = JSON.parse(raw) as StateRecord;
    } catch {
      throw new BadRequestException('No App creation is in progress');
    }

    if (Date.parse(record.expiresAt) <= Date.now()) {
      throw new BadRequestException('That App creation timed out. Start again.');
    }

    const a = Buffer.from(record.value);
    const b = Buffer.from(supplied || '');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException('State mismatch');
    }
    return record.returnTo;
  }

  async completeManifestFlow(code: string, state: string): Promise<string | undefined> {
    if (!code) throw new BadRequestException('GitHub did not return a code');
    const returnTo = await this.consumeState(state);

    const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json' }
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(`manifest conversion failed (${response.status}): ${body}`);
      throw new BadRequestException('GitHub rejected the App creation');
    }

    const app = (await response.json()) as ManifestConversion;
    await this.config.save({
      appId: String(app.id),
      slug: app.slug,
      privateKey: app.pem,
      webhookSecret: app.webhook_secret,
      clientId: app.client_id,
      clientSecret: app.client_secret
    });

    this.logger.log(`GitHub App ${app.slug} created and stored`);
    return returnTo;
  }

  installUrl(): string | null {
    const slug = this.config.get().slug;
    return slug ? `https://github.com/apps/${slug}/installations/new` : null;
  }
}
