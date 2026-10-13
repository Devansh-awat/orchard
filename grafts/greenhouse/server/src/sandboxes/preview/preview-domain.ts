import type { InstanceConfigService } from '../../core/instance-config.service';
import { SANDBOX_RUNNERS } from '../../core/instance-config.sections';
import { normalizePreviewDomain, previewDomainConflict } from './preview-auth';

export interface PreviewDomainResolution {
  domain: string | null;
  conflict: string | null;
}

export function resolvePreviewDomain(raw: string | null | undefined): PreviewDomainResolution {
  const domain = normalizePreviewDomain(raw);
  if (!domain) return { domain: null, conflict: null };
  const conflict = previewDomainConflict(domain, {
    cookieDomain: process.env.COOKIE_DOMAIN,
    frontendUrl: process.env.FRONTEND_URL,
    apiUrl: process.env.API_URL,
    platformOrigins: process.env.PLATFORM_ORIGINS
  });
  return conflict ? { domain: null, conflict } : { domain, conflict: null };
}

const cache = new WeakMap<
  InstanceConfigService,
  { generation: number; value: PreviewDomainResolution }
>();

export function configuredPreviewDomain(config: InstanceConfigService): PreviewDomainResolution {
  const generation = config.generation;
  const cached = cache.get(config);
  if (cached && cached.generation === generation) return cached.value;
  const value = resolvePreviewDomain(config.value(SANDBOX_RUNNERS, 'previewDomain'));
  cache.set(config, { generation, value });
  return value;
}
