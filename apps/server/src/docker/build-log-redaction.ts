import { redactUrlUserinfo } from '../git/clone-credential';

export const MIN_MASKED_SECRET_LENGTH = 8;
export const SECRET_MASK = '****';

export function registryHostsOf(registries: Array<string | null | undefined>): string[] {
  const hosts = new Set<string>();
  for (const reg of registries) {
    if (!reg) continue;
    const host = reg.replace(/^https?:\/\//, '').split('/')[0];
    if (host) hosts.add(host);
  }
  return Array.from(hosts);
}

export function sanitizeBuildLogMessage(
  message: string,
  registryHosts: readonly string[] = []
): string {
  let sanitized = message.replace(
    /(x-access-token:|ghs_|ghp_|github_pat_|dckr_pat_)[a-zA-Z0-9_-]+/gi,
    '***REDACTED***'
  );
  sanitized = redactUrlUserinfo(sanitized);
  sanitized = sanitized.replace(
    /https?:\/\/[^:@\s]+:[^@\s]+@github\.com/gi,
    'https://***@github.com'
  );
  sanitized = sanitized.replace(/https?:\/\/[^@\s]+@github\.com/gi, 'https://***@github.com');
  sanitized = sanitized.replace(
    /(Bearer|Token|Authorization:)\s+[a-zA-Z0-9_\-.]+/gi,
    '$1 ***REDACTED***'
  );
  sanitized = sanitized.replace(
    /(password|passwd|pwd|secret|key|token)[\s]*[=:]['"]?([^\s'"]+)/gi,
    '$1=***REDACTED***'
  );
  sanitized = sanitized.replace(
    /"(auth|password|identitytoken|registrytoken)"\s*:\s*"[^"]*"/gi,
    '"$1":"***REDACTED***"'
  );
  for (const host of registryHosts) {
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    sanitized = sanitized.replace(new RegExp(escaped, 'g'), '***registry***');
  }
  return sanitized;
}

export function secretValuesToMask(
  env: Record<string, string>,
  secretKeys: Iterable<string>
): string[] {
  const values = new Set<string>();
  for (const key of secretKeys) {
    const value = env[key];
    if (typeof value === 'string' && value.length >= MIN_MASKED_SECRET_LENGTH) values.add(value);
  }
  return Array.from(values).sort((a, b) => b.length - a.length);
}

export function maskSecretValues(text: string, values: readonly string[] | undefined): string {
  if (!values || values.length === 0 || !text) return text;
  let out = text;
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join(SECRET_MASK);
  }
  return out;
}
