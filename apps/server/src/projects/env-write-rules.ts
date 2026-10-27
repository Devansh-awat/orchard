import { BadRequestException } from '@nestjs/common';

export interface StoredEnvVar {
  key: string;
  value: string;
  secret: boolean;
}

export interface EnvVarWrite {
  key: string;
  value?: string | null;
  secret?: boolean | null;
}

export const DEFAULT_SECRET_KEY_RE =
  /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|_KEY$|DATABASE_URL|DSN|CREDENTIALS?)/i;

const PUBLIC_BUNDLE_PREFIX_RE =
  /^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)/i;

export function looksSecret(key: string): boolean {
  const trimmed = key.trim();
  if (PUBLIC_BUNDLE_PREFIX_RE.test(trimmed)) return false;
  return DEFAULT_SECRET_KEY_RE.test(trimmed);
}

export function defaultSecretFlag(key: string, requested?: boolean | null): boolean {
  if (typeof requested === 'boolean') return requested;
  return looksSecret(key);
}

export function resolveSecretFlag(
  key: string,
  requested: boolean | null | undefined,
  existing: { secret: boolean } | undefined
): boolean {
  if (!existing) return defaultSecretFlag(key, requested);
  if (existing.secret && requested === false) {
    throw new BadRequestException(
      `${key} is sealed and cannot be made visible again. Delete it and add it back to change that.`
    );
  }
  return typeof requested === 'boolean' ? requested : existing.secret;
}

export function applyEnvKeepRules(
  input: EnvVarWrite[],
  before: Map<string, StoredEnvVar>
): StoredEnvVar[] {
  return input
    .filter((entry) => entry && typeof entry.key === 'string')
    .map((entry) => {
      const key = entry.key.trim();
      const existing = before.get(key);
      const secret = resolveSecretFlag(key, entry.secret, existing);
      const blankKeepsSecret = entry.value === '' && existing?.secret && secret;
      const keeps = entry.value === undefined || entry.value === null || blankKeepsSecret;

      return {
        key,
        value: keeps ? (existing?.value ?? '') : String(entry.value),
        secret
      };
    })
    .filter((entry) => entry.key.length > 0);
}
