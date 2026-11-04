export interface ObjectStorage {
  accountId: string | null;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  bucketName: string | null;
  endpoint: string | null;
  publicUrl: string | null;
  buildContextBucket: string | null;
  backupBucket: string | null;
  region: string;
  pathStyle: boolean | null;
}

export type StoredObjectStorage = Partial<Record<keyof ObjectStorage, string | null>>;

export const UPLOADS_API_PATH = '/apiv1/uploads';
export const UPLOADS_KEY_PREFIX = 'uploads/';

// Set by InstanceConfigService when stored config loads or changes. A module
// variable rather than an injected service because ImageBuilderService reads
// its S3 settings as class fields.
let stored: StoredObjectStorage = {};
let version = 0;

export function setObjectStorageOverride(values: StoredObjectStorage): void {
  stored = values;
  version += 1;
}

export function objectStorageGeneration(): number {
  return version;
}

function pick(env: string, key: keyof ObjectStorage): string | null {
  const value = process.env[env];
  if (value && value.length > 0) return value;
  return stored[key] ?? null;
}

function parsePathStyle(value: string | null): boolean | null {
  if (value === null) return null;
  return value.trim().toLowerCase() === 'true';
}

export function objectStorage(): ObjectStorage {
  const accountId = pick('R2_ACCOUNT_ID', 'accountId');
  return {
    accountId,
    accessKeyId: pick('R2_ACCESS_KEY_ID', 'accessKeyId'),
    secretAccessKey: pick('R2_SECRET_ACCESS_KEY', 'secretAccessKey'),
    bucketName: pick('R2_BUCKET_NAME', 'bucketName'),
    endpoint:
      pick('R2_ENDPOINT', 'endpoint') ??
      (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null),
    publicUrl:
      pick('R2_PUBLIC_URL', 'publicUrl') ?? (accountId ? `https://pub-${accountId}.r2.dev` : null),
    buildContextBucket: pick('R2_BUILD_CONTEXT_BUCKET', 'buildContextBucket'),
    backupBucket: pick('R2_BACKUP_BUCKET', 'backupBucket'),
    region: pick('R2_REGION', 'region') ?? 'auto',
    pathStyle: parsePathStyle(pick('R2_PATH_STYLE', 'pathStyle'))
  };
}

export interface LocalObjectStore {
  endpoint: string;
  backupBucket: string;
  uploadsBucket: string | null;
  region: string;
  accessKey: string;
  secretKey: string;
}

export function localObjectStore(): LocalObjectStore | null {
  const endpoint = process.env.LOCAL_STORE_ENDPOINT;
  const backupBucket = process.env.LOCAL_STORE_BACKUP_BUCKET;
  const accessKey = process.env.LOCAL_STORE_ACCESS_KEY_ID;
  const secretKey = process.env.LOCAL_STORE_SECRET_ACCESS_KEY;
  if (!endpoint || !backupBucket || !accessKey || !secretKey) return null;
  return {
    endpoint,
    backupBucket,
    uploadsBucket: process.env.LOCAL_STORE_UPLOADS_BUCKET || null,
    region: process.env.LOCAL_STORE_REGION || 'auto',
    accessKey,
    secretKey
  };
}

export interface BackupTarget {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  pathStyle: boolean;
  local: boolean;
}

export function platformBackupTarget(): BackupTarget | null {
  const s = objectStorage();
  if (s.backupBucket && s.endpoint && s.accessKeyId && s.secretAccessKey) {
    return {
      endpoint: s.endpoint,
      bucket: s.backupBucket,
      region: s.region,
      accessKey: s.accessKeyId,
      secretKey: s.secretAccessKey,
      pathStyle: s.pathStyle ?? true,
      local: false
    };
  }
  const local = localObjectStore();
  if (!local) return null;
  return {
    endpoint: local.endpoint,
    bucket: local.backupBucket,
    region: local.region,
    accessKey: local.accessKey,
    secretKey: local.secretKey,
    pathStyle: true,
    local: true
  };
}

function backupProxyActive(): boolean {
  return process.env.BACKUP_PROXY_ENABLED === 'true';
}

export function storageManagedByEnv(): boolean {
  return Boolean(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

export function tenantBackupTarget(): BackupTarget | null {
  const target = platformBackupTarget();
  if (!target) return null;
  if (backupProxyActive() || storageManagedByEnv()) return target;
  return null;
}

export function proxyHasChartUpstream(): boolean {
  return process.env.BACKUP_PROXY_CHART_UPSTREAM === 'true';
}

export function currentProxyTarget(): BackupTarget | null {
  const target = platformBackupTarget();
  if (!target || target.local) return null;
  if (storageManagedByEnv() && proxyHasChartUpstream()) return null;
  return target;
}

export interface UploadStorage {
  endpoint: string;
  region: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
  keyPrefix: string;
  local: boolean;
}

export function externalUploadStorage(): UploadStorage | null {
  const s = objectStorage();
  if (!s.accessKeyId || !s.secretAccessKey || !s.bucketName || !s.endpoint) return null;
  return {
    endpoint: s.endpoint,
    region: s.region,
    pathStyle: s.pathStyle ?? false,
    accessKeyId: s.accessKeyId,
    secretAccessKey: s.secretAccessKey,
    bucket: s.bucketName,
    publicUrl: s.publicUrl ?? UPLOADS_API_PATH,
    keyPrefix: s.publicUrl ? '' : UPLOADS_KEY_PREFIX,
    local: false
  };
}

export function uploadStorage(): UploadStorage | null {
  const external = externalUploadStorage();
  if (external) return external;
  const local = localObjectStore();
  if (!local?.uploadsBucket) return null;
  return {
    endpoint: local.endpoint,
    region: local.region,
    pathStyle: true,
    accessKeyId: local.accessKey,
    secretAccessKey: local.secretKey,
    bucket: local.uploadsBucket,
    publicUrl: UPLOADS_API_PATH,
    keyPrefix: UPLOADS_KEY_PREFIX,
    local: true
  };
}

export function s3ClientConfig(target: {
  endpoint: string;
  region: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}) {
  return {
    endpoint: target.endpoint,
    region: target.region,
    forcePathStyle: target.pathStyle,
    credentials: { accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey }
  };
}

const PRIVATE_IPV4 =
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

export function buildsCanReach(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const port = url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443;
  if (port !== 80 && port !== 443) return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.startsWith('[')) return false;
  if (host.endsWith('.svc') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  return !PRIVATE_IPV4.test(host);
}

export interface BuildContextStorage {
  endpoint: string;
  region: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

function flagValue(name: string): boolean | null {
  const raw = String(process.env[name] ?? '')
    .trim()
    .toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return null;
}

export function buildContextStorage(): BuildContextStorage | null {
  const s = objectStorage();
  const forced = flagValue('LOCAL_DEPLOYS_ENABLED');
  if (forced === false) return null;
  if (!s.endpoint || !s.accessKeyId || !s.secretAccessKey) return null;
  const connection = {
    endpoint: s.endpoint,
    region: s.region,
    pathStyle: s.pathStyle ?? false,
    accessKeyId: s.accessKeyId,
    secretAccessKey: s.secretAccessKey
  };
  if (forced === true) {
    return s.buildContextBucket ? { ...connection, bucket: s.buildContextBucket } : null;
  }
  if (storageManagedByEnv() || !buildsCanReach(s.endpoint)) return null;
  const bucket = s.buildContextBucket ?? s.bucketName ?? s.backupBucket;
  return bucket ? { ...connection, bucket } : null;
}

export interface StorageFeatures {
  s3: boolean;
  backups: 'external' | 'local' | 'none';
  uploads: boolean;
  localDeploys: boolean;
}

export function storageFeatures(): StorageFeatures {
  const target = tenantBackupTarget();
  const s = objectStorage();
  return {
    s3: Boolean(s.endpoint && s.accessKeyId && s.secretAccessKey),
    backups: !target ? 'none' : target.local ? 'local' : 'external',
    uploads: uploadStorage() !== null,
    localDeploys: buildContextStorage() !== null
  };
}

export const LOCAL_DEPLOYS_NEED_S3 =
  'Local deploys need S3 storage. Add it under Instance admin, or run: sudo orchardctl backups s3 set';

const BUCKET_IN_PATH = /^s3:\/\/([^/]+)/;

export function bucketFromDestination(destinationPath: string | null | undefined): string | null {
  return destinationPath?.match(BUCKET_IN_PATH)?.[1] ?? null;
}

export interface OrgBackupStorage {
  backupR2Endpoint?: string | null;
  backupR2Bucket?: string | null;
  backupR2AccessKey?: string | null;
  backupR2SecretKey?: string | null;
}

export function orgHasOwnBackupStorage(org: OrgBackupStorage | null | undefined): boolean {
  return Boolean(
    org?.backupR2Endpoint && org?.backupR2Bucket && org?.backupR2AccessKey && org?.backupR2SecretKey
  );
}

export function hasBackupRoute(org: OrgBackupStorage | null | undefined): boolean {
  return orgHasOwnBackupStorage(org) || tenantBackupTarget() !== null;
}
