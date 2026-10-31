export interface PublishedNote {
  version: string;
  file: string;
  publishedAt: string | null;
  url: string | null;
}

export function parseLatest(raw: unknown): PublishedNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const version = typeof value.version === 'string' ? value.version.trim() : '';
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const file =
    typeof value.file === 'string' && /^[\w.-]+\.md$/.test(value.file)
      ? value.file
      : `${version}.md`;
  return {
    version,
    file,
    publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt : null,
    url: typeof value.url === 'string' ? value.url : null
  };
}

export function updatesBase(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.UPDATES_URL ?? 'https://assets.orchard.my/updates/ui').trim();
  if (!raw || raw === 'off') return null;
  return raw.replace(/\/+$/, '');
}
