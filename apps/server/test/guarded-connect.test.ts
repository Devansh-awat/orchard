import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import dnsPromises from 'node:dns/promises';
import { request } from 'node:http';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { BadRequestException } from '@nestjs/common';
import { createRequire } from 'node:module';
import {
  guardedAgents,
  guardedS3Options,
  resolvePublicHost
} from '../src/notifications/webhook-guard';
import { DatabasesService } from '../src/projects/databases.service';

const requireCjs = createRequire(__filename);

function stubLookup(table: Record<string, { address: string; family: number }[]>) {
  return mock.method(dnsPromises, 'lookup', async (host: string) => {
    const hit = table[host];
    if (!hit) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return hit;
  });
}

test('resolvePublicHost rejects private literals, mapped ipv6 and internal suffixes', async () => {
  for (const host of ['10.0.0.5', '127.0.0.1', '::ffff:10.0.0.5', '[::1]', 'db.internal', 'db']) {
    await assert.rejects(resolvePublicHost(host), /public/);
  }
});

test('resolvePublicHost rejects a name with any private answer and pins a clean one', async () => {
  const stub = stubLookup({
    'mixed.example.com': [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.9', family: 4 }
    ],
    'clean.example.com': [{ address: '93.184.216.34', family: 4 }],
    'mapped.example.com': [{ address: '::ffff:169.254.169.254', family: 6 }]
  });
  try {
    await assert.rejects(resolvePublicHost('mixed.example.com'), /public address/);
    await assert.rejects(resolvePublicHost('mapped.example.com'), /public address/);
    const ok = await resolvePublicHost('clean.example.com');
    assert.equal(ok.address, '93.184.216.34');
    assert.equal(ok.hostname, 'clean.example.com');
  } finally {
    stub.mock.restore();
  }
});

test('the import validation connects to the pinned address, not the hostname', async () => {
  const stub = stubLookup({ 'src.example.com': [{ address: '93.184.216.34', family: 4 }] });
  const pg = requireCjs('pg');
  let seen: any = null;
  const fake = mock.method(pg, 'Client', function Fake(this: any, cfg: any) {
    seen = cfg;
    return {
      connect: async () => {
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      },
      end: async () => undefined
    };
  });
  try {
    const validate = (DatabasesService.prototype as any).validateImportSource;
    await assert.rejects(
      validate.call(
        {},
        {
          host: 'src.example.com',
          user: 'u',
          password: 'p',
          database: 'd',
          sslMode: 'require'
        }
      ),
      BadRequestException
    );
    assert.equal(seen.host, '93.184.216.34');
    assert.equal(seen.ssl.servername, 'src.example.com');
  } finally {
    fake.mock.restore();
    stub.mock.restore();
  }
});

test('the import validation refuses a host that rebinds to an internal address', async () => {
  const stub = stubLookup({ 'rebind.example.com': [{ address: '10.96.0.1', family: 4 }] });
  try {
    const validate = (DatabasesService.prototype as any).validateImportSource;
    await assert.rejects(
      validate.call({}, { host: 'rebind.example.com', user: 'u', password: 'p', database: 'd' }),
      /public address/
    );
  } finally {
    stub.mock.restore();
  }
});

test('the guarded agent refuses to connect to a private listener at connect time', async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.end('leak');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  try {
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      const req = request(
        { hostname: 'localhost', port, agent: guardedAgents().httpAgent },
        () => resolve(new Error('connected') as NodeJS.ErrnoException)
      );
      req.on('error', resolve);
      req.end();
    });
    assert.equal(err.code, 'EBLOCKED');
    assert.equal(hits, 0);
  } finally {
    server.close();
  }
});

test('an S3 client built with guardedS3Options never reaches a private endpoint', async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.end('<ListBucketResult/>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  try {
    await assert.rejects(guardedS3Options(`http://127.0.0.1:${port}`), /public address/);
    const s3 = new S3Client({
      endpoint: `http://localhost:${port}`,
      region: 'auto',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
      forcePathStyle: true,
      maxAttempts: 1,
      requestHandler: guardedAgents()
    });
    await assert.rejects(s3.send(new ListObjectsV2Command({ Bucket: 'b' })));
    assert.equal(hits, 0);
    s3.destroy();
  } finally {
    server.close();
  }
});
