import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const DEFAULT_PORT = '5432';

export type TestDatabase = { url: string; source: string } | { refused: string };

function dotenvValue(file: string, key: string): string | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const raw of text.split('\n')) {
    const match = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] !== key) continue;
    return match[2].replace(/^(['"])(.*)\1$/, '$2').trim() || null;
  }
  return null;
}

function isLoopbackHost(raw: string): boolean {
  const host = raw.toLowerCase().replace(/\.$/, '');
  if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost')) return true;
  if (/^127(\.\d{1,3}){0,3}$/.test(host)) return true;
  const bare = host.replace(/^\[|\]$/g, '');
  return bare === '::1' || /^::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|127(\.\d{1,3}){3})$/.test(bare);
}

export function isDefaultLocalDatabase(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return isLoopbackHost(parsed.hostname) && (parsed.port || DEFAULT_PORT) === DEFAULT_PORT;
}

function isThrowawayCandidate(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return isLoopbackHost(parsed.hostname) && (parsed.port || DEFAULT_PORT) !== DEFAULT_PORT;
}

export function resolveTestDatabase(
  env: NodeJS.ProcessEnv = process.env,
  envFiles: string[] = [resolve(__dirname, '../../.env'), resolve(__dirname, '../../../../.env')]
): TestDatabase {
  const explicit = env.TEST_DATABASE_URL?.trim();
  if (explicit) return { url: explicit, source: 'TEST_DATABASE_URL' };
  let url = env.DATABASE_URL?.trim() || null;
  let source = 'DATABASE_URL';
  for (const file of envFiles) {
    if (url) break;
    url = dotenvValue(file, 'DATABASE_URL');
    source = `DATABASE_URL in ${file}`;
  }
  if (!url) {
    return {
      refused:
        'No database for this test. Set TEST_DATABASE_URL to a throwaway Postgres (for example docker run -p 15432:5432 postgres:16 and prisma migrate deploy against it).'
    };
  }
  if (isDefaultLocalDatabase(url)) {
    return {
      refused: `${source} points at localhost:5432, which is usually a port-forward to a real database. This test writes and deletes rows, so it refuses to run there. Set TEST_DATABASE_URL to a throwaway Postgres instead.`
    };
  }
  if (!isThrowawayCandidate(url)) {
    return {
      refused: `${source} is not a loopback database on a non-default port, so it could be a real one. This test writes and deletes rows; set TEST_DATABASE_URL to a throwaway Postgres to run it.`
    };
  }
  return { url, source };
}

export function testPrismaClient(): PrismaClient {
  const db = resolveTestDatabase();
  if ('refused' in db) throw new Error(db.refused);
  return new PrismaClient({ datasourceUrl: db.url });
}
