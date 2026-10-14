export interface ObjectStorage {
  accountId: string | null;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  bucketName: string | null;
  endpoint: string | null;
  publicUrl: string | null;
  buildContextBucket: string | null;
  backupBucket: string | null;
}

// Set by InstanceConfigService when stored config loads or changes. A module
// variable rather than an injected service because ImageBuilderService reads
// its S3 settings as class fields.
let stored: Partial<ObjectStorage> = {};
let version = 0;

export function setObjectStorageOverride(values: Partial<ObjectStorage>): void {
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
    backupBucket: pick('R2_BACKUP_BUCKET', 'backupBucket')
  };
}

export function platformBackupTarget(): {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
} | null {
  const s = objectStorage();
  if (!s.backupBucket || !s.endpoint || !s.accessKeyId || !s.secretAccessKey) return null;
  return {
    endpoint: s.endpoint,
    bucket: s.backupBucket,
    accessKey: s.accessKeyId,
    secretKey: s.secretAccessKey
  };
}
