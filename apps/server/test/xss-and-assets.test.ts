import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { reencodeImage } from '../src/organizations/image-reencode';
import { UploadsController, servableImageType } from '../src/organizations/uploads.controller';
import { StorageService } from '../src/organizations/storage.service';
import { groupLines } from '../src/observability/observability.service';
import { rowsToEntries } from '../src/logs/entries';
import { ProjectsService } from '../src/projects/projects.service';
import { FaviconService } from '../src/projects/favicon.service';

async function png(): Promise<Buffer> {
  return sharp({
    create: { width: 32, height: 32, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } }
  })
    .png()
    .toBuffer();
}

test('reencodeImage turns decodable pixels into server-made webp', async () => {
  const out = await reencodeImage(await png());
  assert.equal(out.contentType, 'image/webp');
  assert.equal(out.buffer.toString('ascii', 0, 4), 'RIFF');
});

test('reencodeImage rejects html, polyglot text and svg by default', async () => {
  await assert.rejects(
    reencodeImage(Buffer.from('<html><script>alert(1)</script></html>'.repeat(10))),
    BadRequestException
  );
  await assert.rejects(
    reencodeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')),
    BadRequestException
  );
});

test('reencodeImage rasterizes svg only when allowed and refuses external refs', async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><script>alert(1)</script><rect width="40" height="40" fill="red"/></svg>'
  );
  const out = await reencodeImage(svg, { allowSvg: true, format: 'png' });
  assert.equal(out.contentType, 'image/png');
  assert.equal(out.buffer.subarray(1, 4).toString('ascii'), 'PNG');
  assert.ok(!out.buffer.includes(Buffer.from('script')));
  const external = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="4" height="4"><image xlink:href="http://169.254.169.254/x"/></svg>'
  );
  await assert.rejects(reencodeImage(external, { allowSvg: true }), BadRequestException);
});

test('reencodeImage enforces the pixel cap', async () => {
  await assert.rejects(reencodeImage(await png(), { maxPixels: 100 }), BadRequestException);
});

test('storage uploadImage never stores the client bytes, type or extension', async () => {
  const storage = new StorageService();
  const seen: any[] = [];
  (storage as any).uploadFile = async (file: any, folder: string) => {
    seen.push({ file, folder });
    return 'ok';
  };
  await assert.rejects(
    storage.uploadImage(
      {
        buffer: Buffer.from('<html><script>alert(1)</script></html>'),
        mimetype: 'image/png',
        originalname: 'x.html',
        size: 10
      } as any,
      'users'
    ),
    BadRequestException
  );
  assert.equal(seen.length, 0);
  await storage.uploadImage(
    { buffer: await png(), mimetype: 'text/html', originalname: 'x.html', size: 1 } as any,
    'users'
  );
  assert.equal(seen[0].file.mimetype, 'image/webp');
  assert.equal(seen[0].file.originalname, 'image.webp');
});

test('servableImageType trusts only raster types tied to the extension', () => {
  assert.equal(servableImageType('a/b.png', 'image/png'), 'image/png');
  assert.equal(servableImageType('a/b.png', 'text/html'), 'image/png');
  assert.equal(servableImageType('a/b.png', 'image/svg+xml'), 'image/png');
  assert.equal(servableImageType('a/b.svg', 'image/svg+xml'), null);
  assert.equal(servableImageType('a/b.html', 'image/png'), null);
});

function fakeRes() {
  const headers: Record<string, string> = {};
  const res: any = {
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    destroy: () => {},
    on: () => res,
    once: () => res,
    emit: () => true,
    write: () => true,
    end: () => {}
  };
  return { res, headers };
}

test('uploads route serves a mis-stored html object as an attachment with lockdown headers', async () => {
  const storage = {
    readUpload: async () => ({
      body: Readable.from([Buffer.from('<script>alert(1)</script>')]),
      contentType: 'text/html',
      length: 24
    })
  };
  const controller = new UploadsController(storage as any);
  const { res, headers } = fakeRes();
  await controller.read('organizations/x.html', res);
  assert.equal(headers['content-type'], 'application/octet-stream');
  assert.equal(headers['content-disposition'], 'attachment');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['content-security-policy'], "default-src 'none'; sandbox");
});

test('uploads route serves a stored svg as an attachment', async () => {
  const storage = {
    readUpload: async () => ({
      body: Readable.from([Buffer.from('<svg/>')]),
      contentType: 'image/svg+xml',
      length: 6
    })
  };
  const controller = new UploadsController(storage as any);
  const { res, headers } = fakeRes();
  await controller.read('favicons/x.svg', res);
  assert.equal(headers['content-type'], 'application/octet-stream');
  assert.equal(headers['content-disposition'], 'attachment');
});

test('favicon pipeline stores nothing when the bytes do not decode', async () => {
  const svc: any = new FaviconService({} as any, {} as any);
  const sent: any[] = [];
  svc.s3Client = { send: async (c: any) => sent.push(c) };
  svc.bucketName = 'b';
  svc.keyPrefix = 'p/';
  svc.publicUrl = 'https://u';
  const out = await svc.storeToR2(
    'evil.test',
    'favicons/evil.test.png',
    Buffer.from('<html><script>alert(1)</script></html>'.repeat(10)),
    'image/png'
  );
  assert.equal(out, null);
  assert.equal(sent.length, 0);
});

test('favicon pipeline stores server-encoded png with a server-chosen type', async () => {
  const svc: any = new FaviconService({} as any, {} as any);
  const sent: any[] = [];
  svc.s3Client = { send: async (c: any) => sent.push(c) };
  svc.bucketName = 'b';
  svc.keyPrefix = 'p/';
  svc.publicUrl = 'https://u';
  const out = await svc.storeToR2('ok.test', 'favicons/ok.test.png', await png(), 'text/html');
  assert.equal(out, 'https://u/favicons/ok.test.png');
  assert.equal(sent[0].input.ContentType, 'image/png');
  assert.equal(sent[0].input.Body.subarray(1, 4).toString('ascii'), 'PNG');
});

test('tenant JSON cannot override server-owned log metadata', () => {
  const [entry] = groupLines(['{"msg":"hi","pod":"<img src=x onerror=alert(1)>","user":"u"}']);
  assert.deepEqual(entry.metadata, { user: 'u' });
  const [stored] = rowsToEntries([
    { _time: '2026-01-01T00:00:00Z', _msg: '{"msg":"hi","pod":"evil"}', pod: 'real-abc' } as any
  ]);
  assert.equal(stored.metadata?.pod, 'real-abc');
});

test('repositoryUrl accepts only http(s)', () => {
  assert.equal(ProjectsService.normalizeRepositoryUrl(undefined), null);
  assert.equal(ProjectsService.normalizeRepositoryUrl('  '), null);
  assert.equal(
    ProjectsService.normalizeRepositoryUrl(' https://github.com/a/b '),
    'https://github.com/a/b'
  );
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x/y', 'not a url']) {
    assert.throws(() => ProjectsService.normalizeRepositoryUrl(bad), BadRequestException);
  }
});
