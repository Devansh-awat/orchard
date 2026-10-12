import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const BLOCK = 512;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 20000;

function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function readOctal(buf: Buffer, offset: number, length: number): number {
  const text = readString(buf, offset, length).trim();
  return text ? parseInt(text, 8) : 0;
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const space = body.indexOf(0x20, i);
    if (space === -1) break;
    const len = parseInt(body.subarray(i, space).toString('utf8'), 10);
    if (!len) break;
    const record = body.subarray(space + 1, i + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

export type ExtractedEntry = { path: string; size: number };

export function safeRelativePath(name: string): string {
  const cleaned = name.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned))
    throw new Error(`absolute path in archive: ${name}`);
  const parts = cleaned.split('/');
  if (parts.some((p) => p === '..' || p === '')) throw new Error(`unsafe path in archive: ${name}`);
  if (parts.some((p) => p.startsWith('.') && p !== '.'))
    throw new Error(`dotfile in archive: ${name}`);
  return parts.join('/');
}

export function extractTarGz(archive: Buffer, destination: string): ExtractedEntry[] {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_TOTAL_BYTES });
  const root = resolve(destination);
  mkdirSync(root, { recursive: true });
  const entries: ExtractedEntry[] = [];
  let offset = 0;
  let pendingName: string | null = null;
  let total = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const bodyStart = offset + BLOCK;
    const body = tar.subarray(bodyStart, bodyStart + size);
    offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      pendingName = parsePax(body).path ?? pendingName;
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      pendingName = readString(body, 0, body.length);
      continue;
    }

    const prefix = readString(header, 345, 155);
    const rawName =
      pendingName ??
      (prefix ? `${prefix}/${readString(header, 0, 100)}` : readString(header, 0, 100));
    pendingName = null;
    const rel = safeRelativePath(rawName);
    if (!rel) continue;
    const target = join(root, rel);
    if (!target.startsWith(root + sep)) throw new Error(`path escapes destination: ${rawName}`);

    if (type === '5') {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (type !== '0') throw new Error(`unsupported archive entry type "${type}" for ${rawName}`);

    total += size;
    if (total > MAX_TOTAL_BYTES) throw new Error('archive is larger than 512 MiB');
    if (entries.length >= MAX_FILES) throw new Error(`archive has more than ${MAX_FILES} files`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, { mode: 0o644 });
    entries.push({ path: rel, size });
  }
  return entries;
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function header(name: string, size: number, type: '0' | 'x'): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  buf.write(name.slice(0, 100), 0, 'utf8');
  buf.write(octal(0o644, 8), 100, 'ascii');
  buf.write(octal(0, 8), 108, 'ascii');
  buf.write(octal(0, 8), 116, 'ascii');
  buf.write(octal(size, 12), 124, 'ascii');
  buf.write(octal(0, 12), 136, 'ascii');
  buf.write('        ', 148, 'ascii');
  buf.write(type, 156, 'ascii');
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return buf;
}

function pad(body: Buffer): Buffer {
  const rest = body.length % BLOCK;
  return rest ? Buffer.concat([body, Buffer.alloc(BLOCK - rest, 0)]) : body;
}

export function createTar(files: { path: string; content: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const rel = safeRelativePath(file.path);
    if (Buffer.byteLength(rel) > 100) {
      const record = ` path=${rel}\n`;
      let len = record.length + 1;
      while (`${len}${record}`.length !== len) len = `${len}${record}`.length;
      const pax = Buffer.from(`${len}${record}`, 'utf8');
      chunks.push(header('PaxHeader', pax.length, 'x'), pad(pax));
    }
    chunks.push(header(rel, file.content.length, '0'), pad(file.content));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(chunks);
}
