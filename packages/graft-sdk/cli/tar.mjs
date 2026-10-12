import { gzipSync } from 'node:zlib';

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
