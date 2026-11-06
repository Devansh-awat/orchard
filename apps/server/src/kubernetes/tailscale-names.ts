import { createHash } from 'node:crypto';

const MAX = 63;

function build(kind: string, app: string): string {
  const head = `ts--${kind}`;
  const full = `${head}--${app}`;
  if (full.length <= MAX) return full;
  const hash = createHash('sha256').update(app).digest('hex').slice(0, 8);
  const suffix = `-${hash}`;
  const room = MAX - head.length - 2 - suffix.length;
  return `${head}--${app.slice(0, room).replace(/-+$/, '')}${suffix}`;
}

export function tailscaleNames(app: string) {
  return {
    proxy: build('proxy', app),
    keySecret: build('key', app),
    stateSecret: build('state', app),
    serveConfig: build('serve', app),
    netpol: build('isolate', app),
    ciliumPolicy: build('apiserver', app)
  };
}

export function legacyTailscaleNames(app: string) {
  return {
    proxy: `ts-${app}`,
    keySecret: `ts-auth-${app}`,
    stateSecret: `ts-auth-${app}`,
    serveConfig: `ts-serve-${app}`,
    netpol: `ts-isolate-${app}`,
    ciliumPolicy: `ts-apiserver-${app}`
  };
}

export const TAILSCALE_OWNER_LABEL = 'orchard.my/tailscale';
export const TAILSCALE_TARGET_LABEL = 'orchard.my/target-deployment';

export function isTailscaleOwned(
  meta: { labels?: Record<string, string> } | undefined,
  app?: string
): boolean {
  const labels = meta?.labels ?? {};
  if (labels[TAILSCALE_OWNER_LABEL] !== 'true') return false;
  return app === undefined || labels[TAILSCALE_TARGET_LABEL] === app;
}
