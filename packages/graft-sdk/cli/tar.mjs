import { gunzipSync, gzipSync } from 'node:zlib';

const BLOCK = 512;

function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function header(name, size, type) {
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

function pad(body) {
  const rest = body.length % BLOCK;
  return rest ? Buffer.concat([body, Buffer.alloc(BLOCK - rest, 0)]) : body;
}

export function tarGz(files) {
  const chunks = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (Buffer.byteLength(file.path) > 100) {
      const record = ` path=${file.path}\n`;
      let len = record.length + 1;
      while (`${len}${record}`.length !== len) len = `${len}${record}`.length;
      const pax = Buffer.from(`${len}${record}`, 'utf8');
      chunks.push(header('PaxHeader', pax.length, 'x'), pad(pax));
    }
    chunks.push(header(file.path, file.content.length, '0'), pad(file.content));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function field(buf, start, length) {
  const raw = buf.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function paxPath(body) {
  let rest = body.toString('utf8');
  let path = null;
  while (rest.length) {
    const space = rest.indexOf(' ');
    const length = Number(rest.slice(0, space));
    if (!length) break;
    const record = rest.slice(space + 1, length - 1);
    if (record.startsWith('path=')) path = record.slice(5);
    rest = rest.slice(length);
  }
  return path;
}

export function untarGz(archive) {
  const tar = gunzipSync(archive);
  const files = [];
  let offset = 0;
  let longPath = null;
  while (offset + BLOCK <= tar.length) {
    const head = tar.subarray(offset, offset + BLOCK);
    if (head.every((b) => b === 0)) break;
    const size = parseInt(field(head, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(head[156] || 48);
    const prefix = field(head, 345, 155);
    const name = longPath ?? (prefix ? `${prefix}/${field(head, 0, 100)}` : field(head, 0, 100));
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      longPath = paxPath(body);
      continue;
    }
    longPath = null;
    if (type === '5') continue;
    if (type !== '0') throw new Error(`archive entry ${name} is not a regular file`);
    if (name.startsWith('/') || name.split('/').includes('..'))
      throw new Error(`archive entry ${name} has an unsafe path`);
    files.push({ path: name, content: Buffer.from(body) });
  }
  return files;
}
