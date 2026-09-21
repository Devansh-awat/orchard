export interface ConfigField {
  name: string;
  env: string;
  secret?: boolean;
  bool?: boolean;
  fallback?: boolean;
}

export interface ConfigSection {
  id: string;
  key: string;
  fields: ConfigField[];
  required: string[];
  validate?: (values: Record<string, string | null>) => void;
}

const section = (
  id: string,
  key: string,
  fields: ConfigField[],
  required: string[],
  validate?: (values: Record<string, string | null>) => void
): ConfigSection => ({ id, key, fields, required, validate });

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

export const isIpAddress = (value: string): boolean => IPV4.test(value) || IPV6.test(value);

export const STORAGE = section(
  'storage',
  'object_storage',
  [
    { name: 'accountId', env: 'R2_ACCOUNT_ID' },
    { name: 'accessKeyId', env: 'R2_ACCESS_KEY_ID', secret: true },
    { name: 'secretAccessKey', env: 'R2_SECRET_ACCESS_KEY', secret: true },
    { name: 'bucketName', env: 'R2_BUCKET_NAME' },
    { name: 'endpoint', env: 'R2_ENDPOINT' },
    { name: 'publicUrl', env: 'R2_PUBLIC_URL' },
    { name: 'buildContextBucket', env: 'R2_BUILD_CONTEXT_BUCKET' }
  ],
  ['accessKeyId', 'secretAccessKey', 'bucketName']
);

export const EMAIL = section(
  'email',
  'email',
  [
    { name: 'host', env: 'SMTP_HOST' },
    { name: 'port', env: 'SMTP_PORT' },
    { name: 'user', env: 'SMTP_USER' },
    { name: 'pass', env: 'SMTP_PASS', secret: true },
    { name: 'secure', env: 'SMTP_SECURE' },
    { name: 'from', env: 'SMTP_FROM' },
    { name: 'fromName', env: 'SMTP_FROM_NAME' }
  ],
  ['host']
);

export const INGRESS = section(
  'ingress',
  'ingress',
  [{ name: 'cname', env: 'INGRESS_CNAME' }],
  ['cname']
);

export const WILDCARD = section(
  'wildcard',
  'wildcard_tls',
  [
    { name: 'domains', env: 'PLATFORM_WILDCARD_DOMAINS' },
    { name: 'appDomain', env: 'APP_DOMAIN' },
    { name: 'sourceNamespace', env: 'WILDCARD_TLS_SOURCE_NAMESPACE' }
  ],
  ['domains']
);

/**
 * The address publicly exposed ports and databases are published on, for
 * organizations that have not set one of their own. Most instances have
 * exactly one routable address, and asking every organization to discover and
 * retype it is how "This organization does not have a public IP configured"
 * becomes a support question instead of a setting.
 */
export const NETWORK = section(
  'network',
  'network',
  [{ name: 'publicIp', env: 'PUBLIC_EXPOSURE_IP' }],
  ['publicIp'],
  (values) => {
    const ip = (values.publicIp || '').trim();
    if (ip && !isIpAddress(ip)) {
      throw new Error('publicIp must be a valid IPv4 or IPv6 address');
    }
  }
);

/**
 * Credentials for the Cloudflare Tunnel this instance sits behind.
 *
 * A token-managed tunnel keeps its routing table in Cloudflare, not in the
 * cluster, so the box cannot see or change which hostnames reach it. With an
 * API token it can, which turns "add a public hostname in the dashboard, then
 * come back" into a button.
 */
export const TUNNEL = section(
  'tunnel',
  'cloudflare_tunnel',
  [
    { name: 'apiToken', env: 'CLOUDFLARE_API_TOKEN', secret: true },
    { name: 'accountId', env: 'CLOUDFLARE_ACCOUNT_ID' },
    { name: 'tunnelId', env: 'CLOUDFLARE_TUNNEL_ID' },
    { name: 'zoneId', env: 'CLOUDFLARE_ZONE_ID' }
  ],
  ['apiToken', 'accountId', 'tunnelId']
);

export const TURNSTILE = section(
  'turnstile',
  'turnstile',
  [
    { name: 'siteKey', env: 'TURNSTILE_SITE_KEY' },
    { name: 'secretKey', env: 'TURNSTILE_SECRET_KEY', secret: true },
    { name: 'enabled', env: 'TURNSTILE_ENABLED', bool: true, fallback: true },
    { name: 'strict', env: 'TURNSTILE_STRICT', bool: true, fallback: false }
  ],
  ['siteKey', 'secretKey']
);

export const SECTIONS: ConfigSection[] = [
  STORAGE,
  EMAIL,
  INGRESS,
  WILDCARD,
  NETWORK,
  TUNNEL,
  TURNSTILE
];

export const sectionById = (id: string): ConfigSection | undefined =>
  SECTIONS.find((s) => s.id === id);
