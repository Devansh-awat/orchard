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
    { name: 'buildContextBucket', env: 'R2_BUILD_CONTEXT_BUCKET' },
    { name: 'backupBucket', env: 'R2_BACKUP_BUCKET' }
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

/**
 * OAuth apps for the forges people connect with one click, registered once
 * by the instance admin the way the GitHub App is. A self-hosted GitLab is
 * the same app registered against its own base URL.
 */
export const GIT_GITLAB = section(
  'git-gitlab',
  'git_oauth_gitlab',
  [
    { name: 'baseUrl', env: 'GITLAB_OAUTH_BASE_URL' },
    { name: 'clientId', env: 'GITLAB_OAUTH_CLIENT_ID' },
    { name: 'clientSecret', env: 'GITLAB_OAUTH_CLIENT_SECRET', secret: true }
  ],
  ['clientId', 'clientSecret'],
  (values) => {
    const base = (values.baseUrl || '').trim();
    if (base && !/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(base)) {
      throw new Error('baseUrl must be a plain https:// address');
    }
  }
);

export const GIT_BITBUCKET = section(
  'git-bitbucket',
  'git_oauth_bitbucket',
  [
    { name: 'key', env: 'BITBUCKET_OAUTH_KEY' },
    { name: 'secret', env: 'BITBUCKET_OAUTH_SECRET', secret: true }
  ],
  ['key', 'secret']
);

const SANDBOX_RUNNER_NAMES = ['kubernetes', 'vercel'];
const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const positiveInt = (value: string | null, name: string, max: number) => {
  const raw = (value || '').trim();
  if (!raw) return;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`${name} must be a whole number between 1 and ${max}`);
  }
};

export const SANDBOX_RUNNERS = section(
  'sandbox-runners',
  'sandbox_runners',
  [
    {
      name: 'kubernetesEnabled',
      env: 'SANDBOX_RUNNER_KUBERNETES_ENABLED',
      bool: true,
      fallback: true
    },
    { name: 'vercelEnabled', env: 'SANDBOX_RUNNER_VERCEL_ENABLED', bool: true, fallback: false },
    { name: 'defaultRunner', env: 'SANDBOX_DEFAULT_RUNNER' },
    { name: 'vercelToken', env: 'SANDBOX_VERCEL_TOKEN', secret: true },
    { name: 'vercelTeamId', env: 'SANDBOX_VERCEL_TEAM_ID' },
    { name: 'vercelProjectId', env: 'SANDBOX_VERCEL_PROJECT_ID' },
    { name: 'vercelImage', env: 'SANDBOX_VERCEL_IMAGE' },
    { name: 'vercelVcpus', env: 'SANDBOX_VERCEL_VCPUS' },
    { name: 'vercelTimeoutMinutes', env: 'SANDBOX_VERCEL_TIMEOUT_MINUTES' },
    { name: 'bridgeBinaryUrl', env: 'SANDBOX_BRIDGE_BINARY_URL' },
    { name: 'previewDomain', env: 'SANDBOX_PREVIEW_DOMAIN' }
  ],
  [],
  (values) => {
    const runner = (values.defaultRunner || '').trim();
    if (runner && !SANDBOX_RUNNER_NAMES.includes(runner)) {
      throw new Error(`defaultRunner must be one of ${SANDBOX_RUNNER_NAMES.join(', ')}`);
    }
    positiveInt(values.vercelVcpus, 'vercelVcpus', 8);
    positiveInt(values.vercelTimeoutMinutes, 'vercelTimeoutMinutes', 1440);
    const bridge = (values.bridgeBinaryUrl || '').trim();
    if (bridge && !/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(bridge)) {
      throw new Error('bridgeBinaryUrl must be a plain https:// address');
    }
    const preview = (values.previewDomain || '').trim();
    if (preview && !HOSTNAME.test(preview)) {
      throw new Error('previewDomain must be a bare domain name such as preview.example.com');
    }
  }
);

export const SECTIONS: ConfigSection[] = [
  STORAGE,
  EMAIL,
  INGRESS,
  WILDCARD,
  NETWORK,
  TUNNEL,
  TURNSTILE,
  GIT_GITLAB,
  GIT_BITBUCKET,
  SANDBOX_RUNNERS
];

export const sectionById = (id: string): ConfigSection | undefined =>
  SECTIONS.find((s) => s.id === id);
