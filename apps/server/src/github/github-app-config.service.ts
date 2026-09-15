import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';

export const GITHUB_APP_KEY = 'github_app';

export interface GithubAppConfig {
  appId: string | null;
  slug: string | null;
  privateKey: string | null;
  webhookSecret: string | null;
  clientId: string | null;
  clientSecret: string | null;
}

interface StoredConfig {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
}

const EMPTY: GithubAppConfig = {
  appId: null,
  slug: null,
  privateKey: null,
  webhookSecret: null,
  clientId: null,
  clientSecret: null
};

@Injectable()
export class GithubAppConfigService implements OnModuleInit {
  private readonly logger = new Logger(GithubAppConfigService.name);

  private stored: StoredConfig | null = null;

  constructor(
    private readonly settings: InstanceSettingsService,
    private readonly crypto: SecretCryptoService
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    try {
      const raw = await this.settings.get(GITHUB_APP_KEY);
      if (!raw) {
        this.stored = null;
        return;
      }
      const parsed = JSON.parse(raw) as StoredConfig;
      this.stored = {
        ...parsed,
        privateKey: this.crypto.decrypt(parsed.privateKey),
        clientSecret: this.crypto.decrypt(parsed.clientSecret),
        webhookSecret: this.crypto.decrypt(parsed.webhookSecret)
      };
    } catch (e) {
      this.logger.error(`could not read the stored GitHub App config: ${e}`);
      this.stored = null;
    }
  }

  private static env(name: string): string | null {
    const value = process.env[name];
    return value && value.length > 0 ? value : null;
  }

  get(): GithubAppConfig {
    const s = this.stored;
    const privateKey =
      GithubAppConfigService.env('GITHUB_APP_PRIVATE_KEY')?.replace(/\\n/g, '\n') ??
      s?.privateKey ??
      null;

    return {
      ...EMPTY,
      appId: GithubAppConfigService.env('GITHUB_APP_ID') ?? s?.appId ?? null,
      slug: GithubAppConfigService.env('GITHUB_APP_SLUG') ?? s?.slug ?? null,
      privateKey,
      webhookSecret:
        GithubAppConfigService.env('GITHUB_APP_WEBHOOK_SECRET') ?? s?.webhookSecret ?? null,
      clientId: GithubAppConfigService.env('GITHUB_CLIENT_ID') ?? s?.clientId ?? null,
      clientSecret: GithubAppConfigService.env('GITHUB_CLIENT_SECRET') ?? s?.clientSecret ?? null
    };
  }

  /**
   * The OAuth callback GitHub redirects back to.
   *
   * Derived rather than required: the manifest flow registers exactly this URL
   * as the App's only callback, so reading a separate env var meant an App
   * created through Orchard's own button sent `redirect_uri=undefined` and
   * GitHub refused it. GITHUB_REDIRECT_URI still overrides, for instances
   * behind a proxy whose public origin is not FRONTEND_URL.
   */
  callbackUrl(): string {
    const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    return GithubAppConfigService.env('GITHUB_REDIRECT_URI') ?? `${base}/apiv1/github/callback`;
  }

  isConfigured(): boolean {
    const c = this.get();
    return Boolean(c.appId && c.privateKey);
  }

  lockedFields(): string[] {
    return [
      ['appId', 'GITHUB_APP_ID'],
      ['slug', 'GITHUB_APP_SLUG'],
      ['privateKey', 'GITHUB_APP_PRIVATE_KEY'],
      ['webhookSecret', 'GITHUB_APP_WEBHOOK_SECRET'],
      ['clientId', 'GITHUB_CLIENT_ID'],
      ['clientSecret', 'GITHUB_CLIENT_SECRET']
    ]
      .filter(([, envName]) => GithubAppConfigService.env(envName) !== null)
      .map(([field]) => field);
  }

  async save(config: StoredConfig): Promise<void> {
    const payload: StoredConfig = {
      ...config,
      privateKey: this.crypto.encrypt(config.privateKey),
      clientSecret: this.crypto.encrypt(config.clientSecret),
      webhookSecret: this.crypto.encrypt(config.webhookSecret)
    };
    await this.settings.set(GITHUB_APP_KEY, JSON.stringify(payload));
    await this.reload();
  }

  async clear(): Promise<void> {
    await this.settings.delete(GITHUB_APP_KEY);
    this.stored = null;
  }
}
