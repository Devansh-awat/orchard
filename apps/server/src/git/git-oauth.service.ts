import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InstanceConfigService } from '../instance-config/instance-config.service';
import { GIT_BITBUCKET, GIT_GITLAB } from '../instance-config/instance-config.sections';
import { normalizeBaseUrl } from './git-provider';

export type OauthProvider = 'gitlab' | 'bitbucket';

export const OAUTH_PROVIDERS: readonly OauthProvider[] = ['gitlab', 'bitbucket'];

export interface OauthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

export interface OauthIdentity {
  username: string;
  baseUrl: string;
}

const REFRESH_SKEW_MS = 60_000;

export function needsRefresh(expiresAt: Date | null | undefined, now = new Date()): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() - now.getTime() < REFRESH_SKEW_MS;
}

export function expiresAtFrom(expiresIn: unknown, now = new Date()): Date | null {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(now.getTime() + seconds * 1000);
}

/**
 * The instance admin registers one OAuth app per forge, the way the GitHub
 * App is registered, and everyone gets a one-click link. Self-hosted GitLab
 * works too, since the app is registered against whatever base URL the
 * admin put in. Bitbucket Cloud has exactly one base URL.
 */
@Injectable()
export class GitOauthService {
  private readonly logger = new Logger(GitOauthService.name);

  constructor(private readonly instanceConfig: InstanceConfigService) {}

  available(): Record<OauthProvider, { baseUrl: string } | null> {
    return {
      gitlab: this.instanceConfig.isConfigured(GIT_GITLAB) ? { baseUrl: this.gitlabBase() } : null,
      bitbucket: this.instanceConfig.isConfigured(GIT_BITBUCKET)
        ? { baseUrl: 'https://bitbucket.org' }
        : null
    };
  }

  private gitlabBase(): string {
    return (
      normalizeBaseUrl(this.instanceConfig.value(GIT_GITLAB, 'baseUrl') || 'https://gitlab.com') ??
      'https://gitlab.com'
    );
  }

  callbackUrl(provider: OauthProvider): string {
    const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    return `${base}/apiv1/git/oauth/${provider}/callback`;
  }

  baseUrlFor(provider: OauthProvider): string {
    return provider === 'gitlab' ? this.gitlabBase() : 'https://bitbucket.org';
  }

  authorizeUrl(provider: OauthProvider, state: string): string {
    const redirect = encodeURIComponent(this.callbackUrl(provider));
    if (provider === 'gitlab') {
      const clientId = this.instanceConfig.value(GIT_GITLAB, 'clientId');
      if (!clientId) throw new BadRequestException('GitLab sign-in is not set up on this instance');
      const scope = encodeURIComponent('read_api read_repository read_user');
      return `${this.gitlabBase()}/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${redirect}&response_type=code&scope=${scope}&state=${encodeURIComponent(state)}`;
    }
    const key = this.instanceConfig.value(GIT_BITBUCKET, 'key');
    if (!key) throw new BadRequestException('Bitbucket sign-in is not set up on this instance');
    return `https://bitbucket.org/site/oauth2/authorize?client_id=${encodeURIComponent(key)}&response_type=code&state=${encodeURIComponent(state)}`;
  }

  async exchange(provider: OauthProvider, code: string): Promise<OauthTokens> {
    if (provider === 'gitlab') {
      return this.gitlabToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.callbackUrl(provider)
      });
    }
    return this.bitbucketToken({ grant_type: 'authorization_code', code });
  }

  async refresh(provider: OauthProvider, refreshToken: string): Promise<OauthTokens> {
    if (provider === 'gitlab') {
      return this.gitlabToken({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        redirect_uri: this.callbackUrl(provider)
      });
    }
    return this.bitbucketToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  private async gitlabToken(params: Record<string, string>): Promise<OauthTokens> {
    const clientId = this.instanceConfig.value(GIT_GITLAB, 'clientId') ?? '';
    const clientSecret = this.instanceConfig.value(GIT_GITLAB, 'clientSecret') ?? '';
    const res = await fetch(`${this.gitlabBase()}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params })
    });
    return this.readTokens(res, 'GitLab');
  }

  private async bitbucketToken(params: Record<string, string>): Promise<OauthTokens> {
    const key = this.instanceConfig.value(GIT_BITBUCKET, 'key') ?? '';
    const secret = this.instanceConfig.value(GIT_BITBUCKET, 'secret') ?? '';
    const res = await fetch('https://bitbucket.org/site/oauth2/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: new URLSearchParams(params)
    });
    return this.readTokens(res, 'Bitbucket');
  }

  private async readTokens(res: Response, label: string): Promise<OauthTokens> {
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const why = data.error_description || data.error || `${label} answered ${res.status}`;
      throw new BadRequestException(`${label} did not issue a token: ${why}`);
    }
    return {
      accessToken: String(data.access_token),
      refreshToken: data.refresh_token ? String(data.refresh_token) : null,
      expiresAt: expiresAtFrom(data.expires_in)
    };
  }

  async identity(provider: OauthProvider, accessToken: string): Promise<OauthIdentity> {
    const baseUrl = this.baseUrlFor(provider);
    const url =
      provider === 'gitlab' ? `${baseUrl}/api/v4/user` : 'https://api.bitbucket.org/2.0/user';
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
    if (!res.ok)
      throw new BadRequestException(`${provider} rejected the new token (${res.status})`);
    const data: any = await res.json();
    const username = String(data.username ?? data.nickname ?? data.display_name ?? '').trim();
    if (!username)
      throw new BadRequestException(`${provider} did not say who the token belongs to`);
    return { username, baseUrl };
  }
}
