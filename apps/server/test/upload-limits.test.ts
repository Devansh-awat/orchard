import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import multer from 'multer';
import { Observable, of, throwError, lastValueFrom } from 'rxjs';

import { uploadLimits, uploadSlots } from '../src/http/upload-limits';

async function withUploadServer<T>(
  fileSize: number,
  run: (url: string, seen: { bytes: number }) => Promise<T>
): Promise<T> {
  const seen = { bytes: 0 };
  const app = express();
  app.post('/upload', (req, res) => {
    multer(uploadLimits(fileSize)).single('file')(req, res, (err: any) => {
      if (err)
        return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ code: err.code });
      seen.bytes = (req as any).file?.size ?? 0;
      res.json({ ok: true });
    });
  });
  const server = app.listen(0);
  try {
    const port = (server.address() as AddressInfo).port;
    return await run(`http://127.0.0.1:${port}/upload`, seen);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test('a file over the limit is rejected while streaming', async () => {
  await withUploadServer(1024 * 1024, async (url, seen) => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(6 * 1024 * 1024)], { type: 'image/png' }), 'a.png');
    const res = await fetch(url, { method: 'POST', body: form });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { code: 'LIMIT_FILE_SIZE' });
    assert.equal(seen.bytes, 0);
  });
});

test('a file under the limit is accepted', async () => {
  await withUploadServer(1024 * 1024, async (url, seen) => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(512 * 1024)], { type: 'image/png' }), 'a.png');
    const res = await fetch(url, { method: 'POST', body: form });
    assert.equal(res.status, 200);
    assert.equal(seen.bytes, 512 * 1024);
  });
});

test('extra files and fields are refused', async () => {
  await withUploadServer(1024 * 1024, async (url) => {
    const twoFiles = new FormData();
    twoFiles.append('file', new Blob(['a']), 'a.png');
    twoFiles.append('file', new Blob(['b']), 'b.png');
    const first = await fetch(url, { method: 'POST', body: twoFiles });
    assert.equal(first.status, 400);

    const manyFields = new FormData();
    for (let i = 0; i < 50; i += 1) manyFields.append(`f${i}`, 'x');
    manyFields.append('file', new Blob(['a']), 'a.png');
    const second = await fetch(url, { method: 'POST', body: manyFields });
    assert.equal(second.status, 400);
  });
});

function context(sub: string) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ user: { sub } }) })
  } as any;
}

function pending(): { source: Observable<unknown>; finish: () => void } {
  let finish = () => {};
  const source = new Observable<unknown>((subscriber) => {
    finish = () => {
      subscriber.next('done');
      subscriber.complete();
    };
  });
  return { source, finish: () => finish() };
}

test('upload slots cap concurrency per caller and in total', async () => {
  const Slots = uploadSlots(3, 2);
  const interceptor = new Slots();
  const held: Array<() => void> = [];
  const open = (sub: string) => {
    const p = pending();
    const stream = interceptor.intercept(context(sub), { handle: () => p.source });
    const done = lastValueFrom(stream);
    held.push(p.finish);
    return done;
  };

  const a1 = open('a');
  const a2 = open('a');
  assert.throws(
    () => open('a'),
    (err: any) => err.getStatus() === 429
  );
  const b1 = open('b');
  assert.throws(
    () => open('c'),
    (err: any) => err.getStatus() === 429
  );

  held[0]();
  await a1;
  const c1 = open('c');
  held[1]();
  held[2]();
  held[3]();
  await Promise.all([a2, b1, c1]);

  const again = interceptor.intercept(context('a'), { handle: () => of('x') });
  assert.equal(await lastValueFrom(again), 'x');
});

test('upload slots are released when the handler fails', async () => {
  const Slots = uploadSlots(1, 1);
  const interceptor = new Slots();
  const failing = interceptor.intercept(context('a'), {
    handle: () => throwError(() => new Error('boom'))
  });
  await assert.rejects(lastValueFrom(failing), /boom/);
  const next = interceptor.intercept(context('a'), { handle: () => of('ok') });
  assert.equal(await lastValueFrom(next), 'ok');
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

test('every FileInterceptor in the server carries explicit limits', () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const file of sourceFiles(join(__dirname, '../src'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/FileInterceptor\(([^)]*\)?[^)]*)\)/g)) {
      seen += 1;
      if (!/uploadLimits\(|PROVIDER_ICON_UPLOAD/.test(match[1])) offenders.push(file);
    }
  }
  assert.ok(seen >= 6);
  assert.deepEqual(offenders, []);
});
