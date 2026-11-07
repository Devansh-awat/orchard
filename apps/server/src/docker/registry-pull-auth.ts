import { canonicalRegistryHost, isLoopbackHost } from '../projects/image-ref';

export type RegistryAuth = {
  username: string;
  password: string;
  auth: string;
};

export type RegistryAuths = Record<string, RegistryAuth>;

export const PULL_AUTH_ENV_KEYS = new Set(['DOCKER_AUTH_CONFIG', 'DHI_USERNAME', 'DHI_TOKEN']);

export class PullAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PullAuthError';
  }
}

export function isPullAuthEnvKey(key: string): boolean {
  return PULL_AUTH_ENV_KEYS.has(key);
}

export function registryAuth(username: string, password: string): RegistryAuth {
  return {
    username,
    password,
    auth: Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
  };
}

export function dockerConfigJson(auths: RegistryAuths): { auths: RegistryAuths } {
  return { auths };
}

function asAuths(value: unknown, source: string): RegistryAuths {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new PullAuthError(`${source} must be a JSON object of registry auths`);
  }
  const out: RegistryAuths = {};
  for (const [host, entry] of Object.entries(value as Record<string, unknown>)) {
    const name = host.trim();
    if (!name) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new PullAuthError(`${source} entry for ${name} is invalid`);
    }
    const rec = entry as Record<string, unknown>;
    let username = typeof rec.username === 'string' ? rec.username : '';
    let password = typeof rec.password === 'string' ? rec.password : '';
    if ((!username || !password) && typeof rec.auth === 'string') {
      const decoded = Buffer.from(rec.auth, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep <= 0) {
        throw new PullAuthError(`${source} auth for ${name} isn't username:password`);
      }
      username = username || decoded.slice(0, sep);
      password = password || decoded.slice(sep + 1);
    }
    if (!username || !password) {
      throw new PullAuthError(`${source} is missing username/password for ${name}`);
    }
    out[name] = registryAuth(username, password);
  }
  return out;
}

export function parseDockerAuthConfig(raw: string, source = 'DOCKER_AUTH_CONFIG'): RegistryAuths {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PullAuthError(`${source} isn't valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PullAuthError(`${source} must be a Docker config JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  return asAuths(obj.auths ?? obj, source);
}

export function pullAuthsFromEnv(env: Record<string, string>): RegistryAuths {
  const auths: RegistryAuths = {};
  const raw = env.DOCKER_AUTH_CONFIG?.trim();
  if (raw) Object.assign(auths, parseDockerAuthConfig(raw));
  const user = env.DHI_USERNAME?.trim() ?? '';
  const token = env.DHI_TOKEN?.trim() ?? '';
  if (user && !token) throw new PullAuthError('DHI_TOKEN is required when DHI_USERNAME is set');
  if (token && !user) throw new PullAuthError('DHI_USERNAME is required when DHI_TOKEN is set');
  if (user && token) auths['dhi.io'] = registryAuth(user, token);
  return auths;
}

export function mergeRegistryAuths(...sets: RegistryAuths[]): RegistryAuths {
  return Object.assign({}, ...sets);
}

export function hasRegistryAuths(auths: RegistryAuths): boolean {
  return Object.keys(auths).length > 0;
}

export function registryLoginHostError(host: string): string | null {
  const trimmed = host.trim();
  const bare = trimmed.replace(/^https?:\/\//i, '').split('/')[0];
  if (!bare || trimmed.startsWith('-') || canonicalRegistryHost(bare) === null) {
    return `Refusing to log in to ${JSON.stringify(trimmed.slice(0, 80))}: not a registry host`;
  }
  if (isLoopbackHost(bare)) {
    return `Refusing to log in to ${trimmed.slice(0, 80)}: loopback registries are not allowed`;
  }
  return null;
}
