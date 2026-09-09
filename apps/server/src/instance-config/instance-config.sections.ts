export interface ConfigField {
  name: string;
  env: string;
  secret?: boolean;
}

export interface ConfigSection {
  id: string;
  key: string;
  fields: ConfigField[];
  required: string[];
}

const section = (
  id: string,
  key: string,
  fields: ConfigField[],
  required: string[],
): ConfigSection => ({ id, key, fields, required });

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
  ],
  ['accessKeyId', 'secretAccessKey', 'bucketName'],
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
    { name: 'fromName', env: 'SMTP_FROM_NAME' },
  ],
  ['host'],
);

export const INGRESS = section(
  'ingress',
  'ingress',
  [{ name: 'cname', env: 'INGRESS_CNAME' }],
  ['cname'],
);

export const WILDCARD = section(
  'wildcard',
  'wildcard_tls',
  [
    { name: 'domains', env: 'PLATFORM_WILDCARD_DOMAINS' },
    { name: 'appDomain', env: 'APP_DOMAIN' },
    { name: 'sourceNamespace', env: 'WILDCARD_TLS_SOURCE_NAMESPACE' },
  ],
  ['domains'],
);

export const SECTIONS: ConfigSection[] = [STORAGE, EMAIL, INGRESS, WILDCARD];

export const sectionById = (id: string): ConfigSection | undefined =>
  SECTIONS.find((s) => s.id === id);
