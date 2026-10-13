export function formatSlug(value: string): string {
  if (!value) {
    return '';
  }

  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .substring(0, 60)
    .replace(/-+$/, '');
}

type IngressRouting = {
  host?: string | null;
  path?: string | null;
  tlsSecretName?: string | null;
  entrypoints?: string[] | null;
};

export function ingressTlsEnabled(ing: IngressRouting): boolean {
  if (ing.tlsSecretName) return true;
  if (Array.isArray(ing.entrypoints) && ing.entrypoints.length > 0) {
    return ing.entrypoints.includes('websecure');
  }
  return true;
}

export function ingressPublicUrl(ing: IngressRouting): string {
  if (!ing.host) return '';
  const [name, ...rest] = ing.host.split('/');
  if (!name) return '';
  const tls = ingressTlsEnabled(ing);
  const configured = (tls ? process.env.PUBLIC_HTTPS_PORT : process.env.PUBLIC_HTTP_PORT) || '';
  const standard = tls ? '443' : '80';
  const port = configured && configured !== standard ? `:${configured}` : '';
  const embedded = rest.length > 0 ? `/${rest.join('/')}` : '';
  return `${tls ? 'https' : 'http'}://${name}${port}${embedded}${ing.path ?? ''}`;
}

export function scrubIngress<
  T extends IngressRouting & {
    protectionPasswordHash?: string | null;
    protectionBypassSecret?: string | null;
  }
>(
  ing: T
): Omit<T, 'protectionPasswordHash' | 'protectionBypassSecret'> & {
  tlsEnabled: boolean;
  url: string;
} {
  const {
    protectionPasswordHash: _protectionPasswordHash,
    protectionBypassSecret: _protectionBypassSecret,
    ...rest
  } = ing;
  return { ...rest, tlsEnabled: ingressTlsEnabled(ing), url: ingressPublicUrl(ing) };
}
