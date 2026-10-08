import { formatSlug, scrubIngress } from '../../projects/projects.utils';

export type PreviewStatus = 'building' | 'deploying' | 'ready' | 'failed' | 'stopped' | 'gone';

export const PREVIEW_ENV_PREFIX = 'gh-';

const MAX_ENV_SLUG = 60;

export interface PreviewIngressRow {
  host: string | null;
  path: string | null;
  tlsSecretName: string | null;
  entrypoints: string[] | null;
}

export interface PreviewDeploymentRow {
  id: string;
  status: string;
  buildStatus: string;
  stopped: boolean;
  applyStatus?: string | null;
  ingresses?: PreviewIngressRow[];
}

export interface PreviewSnapshot {
  status: PreviewStatus;
  url: string | null;
}

export const PREVIEW_DEPLOYMENT_SELECT = {
  id: true,
  status: true,
  buildStatus: true,
  stopped: true,
  applyStatus: true,
  ingresses: {
    select: { host: true, path: true, tlsSecretName: true, entrypoints: true },
    orderBy: { createdAt: 'asc' as const }
  }
} as const;

export function previewEnvSlug(sessionSlug: string): string {
  const base = sessionSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const room = MAX_ENV_SLUG - PREVIEW_ENV_PREFIX.length;
  const tail = base.length > room ? base.slice(base.length - room).replace(/^-+/, '') : base;
  return formatSlug(`${PREVIEW_ENV_PREFIX}${tail || 'session'}`);
}

export function isPreviewEnvSlug(slug: string | null | undefined): boolean {
  return typeof slug === 'string' && slug.startsWith(PREVIEW_ENV_PREFIX);
}

export function previewStatusOf(dep: PreviewDeploymentRow | null | undefined): PreviewStatus {
  if (!dep) return 'gone';
  if (dep.buildStatus === 'building' || dep.buildStatus === 'pending') return 'building';
  if (dep.buildStatus === 'failed' || dep.buildStatus === 'cancelled') return 'failed';
  if (dep.status === 'failed' || dep.status === 'error' || dep.applyStatus === 'failed') {
    return 'failed';
  }
  if (dep.stopped || dep.status === 'stopped') return 'stopped';
  if (dep.status === 'running' && (!dep.applyStatus || dep.applyStatus === 'synced')) {
    return 'ready';
  }
  return 'deploying';
}

export function previewUrlOf(ingresses: PreviewIngressRow[] | null | undefined): string | null {
  for (const ing of ingresses ?? []) {
    const url = scrubIngress(ing).url;
    if (url) return url;
  }
  return null;
}

export function previewSnapshotOf(dep: PreviewDeploymentRow | null | undefined): PreviewSnapshot {
  return { status: previewStatusOf(dep), url: dep ? previewUrlOf(dep.ingresses) : null };
}

export function normalizeGithubRepo(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const m = value
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .match(/github\.com[/:]([^/\s]+)\/([^/\s]+)$/i);
  if (m) return `${m[1]}/${m[2]}`.toLowerCase();
  const short = value.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return short ? `${short[1]}/${short[2]}`.toLowerCase() : null;
}
