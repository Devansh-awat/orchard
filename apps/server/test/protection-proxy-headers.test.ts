import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { PassThrough } from 'stream';
import { ProtectionService } from '../src/auth/protection.service';

function upstreamEchoingHeaders(): Promise<{ port: number; seen: Promise<any>; close: () => void }> {
  return new Promise((resolve) => {
    let resolveSeen: (v: any) => void;
    const seen = new Promise((r) => { resolveSeen = r; });
    const server = http.createServer((req, res) => {
      resolveSeen(req.headers);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as any;
      resolve({ port, seen, close: () => server.close() });
    });
  });
}

function fakeReq(headers: Record<string, string>) {
  const req = new PassThrough() as any;
  req.headers = headers;
  req.method = 'GET';
  req.url = '/';
  req.originalUrl = '/';
  req.secure = true;
  req.socket = { remoteAddress: '203.0.113.7' };
  req.end();
  return req;
}

function fakeRes() {
  const res = new PassThrough() as any;
  res.writeHead = () => res;
  res.status = () => res;
  res.send = () => res;
  return res;
}

async function proxyAndCaptureHeaders(reqHeaders: Record<string, string>) {
  const upstream = await upstreamEchoingHeaders();
  const svc = Object.create(ProtectionService.prototype) as any;
  await svc.proxyToUpstream(fakeReq(reqHeaders), fakeRes(), '127.0.0.1', upstream.port);
  const seen = await upstream.seen;
  upstream.close();
  return seen;
}

test('the public Host survives the hop to the upstream', async () => {
  const seen = await proxyAndCaptureHeaders({ host: 'staging.attend.hackclub.com' });
  assert.equal(seen.host, 'staging.attend.hackclub.com');
});

test('the upstream is told who the client was', async () => {
  const seen = await proxyAndCaptureHeaders({
    host: 'staging.attend.hackclub.com',
    'x-forwarded-for': '198.51.100.4',
  });
  assert.equal(seen['x-forwarded-for'], '198.51.100.4, 203.0.113.7');
  assert.equal(seen['x-forwarded-host'], 'staging.attend.hackclub.com');
  assert.equal(seen['x-forwarded-proto'], 'https');
});

test('a request with no prior forwarding chain still names its peer', async () => {
  const seen = await proxyAndCaptureHeaders({ host: 'staging.attend.hackclub.com' });
  assert.equal(seen['x-forwarded-for'], '203.0.113.7');
});

test('the bypass secret is never handed to the app', async () => {
  const seen = await proxyAndCaptureHeaders({
    host: 'staging.attend.hackclub.com',
    'x-orchard-protection-bypass': 'super-secret',
  });
  assert.equal(seen['x-orchard-protection-bypass'], undefined);
});
