import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { s3ClientConfig } from './object-storage';

const PROBE_KEY = '.orchard-connection-test';
const PROBE_TIMEOUT_MS = 10_000;

export interface ProbeTarget {
  endpoint: string;
  buckets: string[];
  region: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export type ProbeResult = { ok: true } | { ok: false; message: string };

type Values = Record<string, string | null | undefined>;

export function storageProbeTarget(input: Values, current: Values): ProbeTarget | string {
  const pick = (name: string) => (input[name] || current[name] || '').trim();
  const account = pick('accountId');
  const endpoint =
    pick('endpoint') || (account ? `https://${account}.r2.cloudflarestorage.com` : '');
  const buckets = [
    ...new Set([pick('backupBucket'), pick('bucketName'), pick('buildContextBucket')])
  ].filter(Boolean);
  const accessKeyId = pick('accessKeyId');
  const secretAccessKey = pick('secretAccessKey');
  if (!endpoint) return 'Enter an endpoint.';
  if (!/^https?:\/\/[^\s/]+\/?$/.test(endpoint)) {
    return 'The endpoint must be a plain address such as https://s3.example.com.';
  }
  if (!buckets.length) return 'Enter a bucket.';
  if (!accessKeyId) return 'Enter an access key.';
  if (!secretAccessKey) return 'Enter a secret key.';
  return {
    endpoint,
    buckets,
    region: pick('region') || 'auto',
    pathStyle: pick('pathStyle').toLowerCase() !== 'false',
    accessKeyId,
    secretAccessKey
  };
}

function describeFailure(e: any, target: ProbeTarget, bucket: string): string {
  const status = e?.$metadata?.httpStatusCode;
  const name = String(e?.name ?? e?.Code ?? '');
  if (name === 'AbortError' || name === 'TimeoutError') {
    return `No answer from ${target.endpoint} after 10 seconds.`;
  }
  if (name === 'NoSuchBucket' || status === 404) {
    return `The bucket ${bucket} doesn't exist at ${target.endpoint}.`;
  }
  if (
    name === 'AuthorizationHeaderMalformed' ||
    name === 'IllegalLocationConstraintException' ||
    name === 'PermanentRedirect' ||
    status === 301
  ) {
    return `The region ${target.region} doesn't match this bucket. Check the region and the addressing style.`;
  }
  if (status === 401 || status === 403 || /AccessDenied|InvalidAccessKey|Signature/.test(name)) {
    return `The bucket refused the key. Check the access key and secret key, and that the key can list, read, write and delete in ${bucket}.`;
  }
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') {
    return `Couldn't find ${target.endpoint}. Check the address.`;
  }
  if (e?.code === 'ECONNREFUSED' || e?.code === 'ECONNRESET' || e?.code === 'ETIMEDOUT') {
    return `Couldn't connect to ${target.endpoint}.`;
  }
  return `The connection test failed: ${name || 'unknown error'}.`;
}

export async function probeStorage(target: ProbeTarget | string): Promise<ProbeResult> {
  if (typeof target === 'string') return { ok: false, message: target };
  const client = new S3Client(s3ClientConfig(target));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  const options = { abortSignal: abort.signal };
  try {
    for (const bucket of target.buckets) {
      try {
        await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }), options);
        await client.send(
          new PutObjectCommand({ Bucket: bucket, Key: PROBE_KEY, Body: 'orchard' }),
          options
        );
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: PROBE_KEY }), options);
      } catch (e) {
        return { ok: false, message: describeFailure(e, target, bucket) };
      }
    }
    return { ok: true };
  } finally {
    clearTimeout(timer);
    client.destroy();
  }
}
