import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

export interface ContractsFile {
  body: Buffer;
  etag: string;
}

const cache = new Map<string, ContractsFile | null>();

export function findContractsFile(name: string, start = __dirname): string | null {
  const override = process.env.ORCHARD_CONTRACTS_DIR;
  if (override) {
    const candidate = resolve(override, name);
    return existsSync(candidate) ? candidate : null;
  }
  let dir = start;
  for (let depth = 0; depth < 10; depth++) {
    const candidate = join(dir, 'packages', 'contracts', name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function readContractsFile(name: string): ContractsFile | null {
  if (cache.has(name)) return cache.get(name)!;
  const path = findContractsFile(name);
  const file = path ? toContractsFile(readFileSync(path)) : null;
  cache.set(name, file);
  return file;
}

export function toContractsFile(body: Buffer): ContractsFile {
  return { body, etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"` };
}

export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const values = (Array.isArray(header) ? header.join(',') : header)
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''));
  return values.includes('*') || values.includes(etag);
}
