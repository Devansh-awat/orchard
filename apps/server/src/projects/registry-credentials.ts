import { registryAuth, type RegistryAuths } from '../docker/registry-pull-auth';

export const REGISTRY_PULL_SECRET_NAME = 'orchard-registry-creds';

const DOCKER_HUB_ALIASES = new Set([
  'docker.io',
  'index.docker.io',
  'registry-1.docker.io',
  'registry.hub.docker.com'
]);

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

export function normalizeRegistryHost(raw: string): string | null {
  let value = (raw ?? '').trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^https?:\/\//, '');
  value = value.split('/')[0];
  if (!value) return null;
  if (DOCKER_HUB_ALIASES.has(value)) return 'docker.io';
  if (!HOST_RE.test(value)) return null;
  if (!value.includes('.') && !value.includes(':') && value !== 'localhost') return null;
  return value;
}

export function imageRegistryHost(image: string): string {
  const ref = (image ?? '').trim();
  const first = ref.split('/')[0];
  const hasRegistry = ref.includes('/') && (first.includes('.') || first.includes(':'));
  if (!hasRegistry) return 'docker.io';
  return normalizeRegistryHost(first) ?? first.toLowerCase();
}

export function imageUsesRegistry(image: string, registries: Iterable<string>): boolean {
  const host = imageRegistryHost(image);
  for (const registry of registries) if (registry === host) return true;
  return false;
}

export function pullSecretsForImage(
  image: string,
  registries: Iterable<string>
): { name: string }[] {
  return imageUsesRegistry(image, registries) ? [{ name: REGISTRY_PULL_SECRET_NAME }] : [];
}

export function registryAuthsFor(
  credentials: { registry: string; username: string; password: string }[]
): RegistryAuths {
  const auths: RegistryAuths = {};
  for (const cred of credentials) {
    const auth = registryAuth(cred.username, cred.password);
    if (cred.registry === 'docker.io') {
      auths['https://index.docker.io/v1/'] = auth;
      auths['docker.io'] = auth;
      continue;
    }
    auths[cred.registry] = auth;
  }
  return auths;
}

export function registryApiBase(registry: string): string {
  if (registry === 'docker.io') return 'https://registry-1.docker.io';
  if (registry.startsWith('localhost')) return `http://${registry}`;
  return `https://${registry}`;
}

export interface BearerChallenge {
  realm: string;
  service?: string;
  scope?: string;
}

export function parseBearerChallenge(header: string | null): BearerChallenge | null {
  if (!header || !/^bearer\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  for (const match of header.slice(7).matchAll(/(\w+)="([^"]*)"/g)) {
    params[match[1].toLowerCase()] = match[2];
  }
  if (!params.realm) return null;
  return { realm: params.realm, service: params.service, scope: params.scope };
}

export function bearerTokenUrl(challenge: BearerChallenge): string {
  const url = new URL(challenge.realm);
  if (challenge.service) url.searchParams.set('service', challenge.service);
  if (challenge.scope) url.searchParams.set('scope', challenge.scope);
  return url.toString();
}
