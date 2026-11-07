import * as crypto from 'crypto';

export const PROXIED_CACHE_PREFIX = '_build-cache/';
export const BUILD_CACHE_KEY_TTL_MS = 2 * 60 * 60 * 1000;
export const BUILD_CACHE_PURPOSE = 'build-cache';
export const S3_TOUCH_REFRESH = '2000000h';

export interface S3CacheEnv {
  BUILDKIT_S3_VIA_PROXY?: string;
  BUILDKIT_S3_BUCKET?: string;
  BUILDKIT_S3_CACHE_PREFIX?: string;
  BACKUP_PROXY_ENABLED?: string;
  BACKUP_PROXY_ENDPOINT?: string;
}

export type S3CacheRoute =
  | { via: 'proxy'; endpoint: string; bucket: string; basePrefix: string }
  | { via: 'direct'; reason: string };

export interface S3CacheTarget {
  endpoint: string;
  bucket: string;
  region: string;
  basePrefix: string;
  scoped: boolean;
}

export function s3CacheRoute(env: S3CacheEnv, platformBucket: string | null): S3CacheRoute {
  const mode = (env.BUILDKIT_S3_VIA_PROXY || 'auto').trim().toLowerCase();
  const endpoint = (env.BACKUP_PROXY_ENDPOINT || '').trim();
  if (mode === 'false') return { via: 'direct', reason: 'BUILDKIT_S3_VIA_PROXY=false' };
  if (env.BACKUP_PROXY_ENABLED !== 'true' || !endpoint) {
    return { via: 'direct', reason: 'the r2-proxy is not enabled' };
  }
  const explicitBucket = (env.BUILDKIT_S3_BUCKET || '').trim();
  const bucket = explicitBucket || platformBucket || '';
  if (!bucket) return { via: 'direct', reason: 'no bucket is known to the r2-proxy' };
  if (mode !== 'true' && explicitBucket && explicitBucket !== platformBucket) {
    return {
      via: 'direct',
      reason: `bucket ${explicitBucket} is not the proxy's platform bucket; set BUILDKIT_S3_VIA_PROXY=true and add it to r2Proxy.allowedBuckets`
    };
  }
  const prefix = (env.BUILDKIT_S3_CACHE_PREFIX || '').trim();
  return {
    via: 'proxy',
    endpoint,
    bucket,
    basePrefix: prefix ? (prefix.endsWith('/') ? prefix : `${prefix}/`) : PROXIED_CACHE_PREFIX
  };
}

export function tenantCacheSegment(tenantKey: string | undefined): string | null {
  const segment = (tenantKey || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, 63);
  return segment || null;
}

export function tenantWritePrefix(
  basePrefix: string,
  tenantKey: string | undefined
): string | null {
  const segment = tenantCacheSegment(tenantKey);
  return segment ? `${basePrefix}${segment}/` : null;
}

export function mintBuildCacheKey(): { accessKey: string; secret: string } {
  return {
    accessKey: `orch-${crypto.randomBytes(8).toString('hex')}`,
    secret: crypto.randomBytes(32).toString('hex')
  };
}
