import test from 'node:test';
import assert from 'node:assert/strict';
import proxyaddr from 'proxy-addr';
import { getClientIp, getRawClientIp } from '../src/auth/client-ip';

const SOCKET = '10.0.0.1';

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function raw(headers: Record<string, string>) {
  return { headers, socket: { remoteAddress: SOCKET } } as any;
}

function expressReq(headers: Record<string, string>, hops: number) {
  const req = raw(headers);
  req.connection = req.socket;
  req.ip = proxyaddr(req, (_addr: string, i: number) => i < hops);
  return req;
}

test('the forwarded-for index matches what Express would pick', () => {
  const cases: [string, number][] = [
    ['1.1.1.1', 1],
    ['1.1.1.1, 2.2.2.2', 1],
    ['1.1.1.1, 2.2.2.2, 3.3.3.3', 1],
    ['1.1.1.1, 2.2.2.2, 3.3.3.3', 2],
    ['1.1.1.1, 2.2.2.2, 3.3.3.3', 3],
    ['1.1.1.1', 2]
  ];
  for (const [xff, hops] of cases) {
    withEnv({ TRUST_PROXY: String(hops), CLIENT_IP_HEADER: undefined }, () => {
      const req = expressReq({ 'x-forwarded-for': xff }, hops);
      assert.equal(getClientIp(req), req.ip, `${xff} @ ${hops} hops`);
    });
  }
});

test('the upgrade path reads forwarded-for instead of settling for the proxy', () => {
  withEnv({ TRUST_PROXY: '2', CLIENT_IP_HEADER: undefined }, () => {
    assert.equal(
      getRawClientIp(raw({ 'x-forwarded-for': '203.0.113.9, 172.16.0.1' })),
      '203.0.113.9'
    );
  });
  withEnv({ TRUST_PROXY: '1', CLIENT_IP_HEADER: undefined }, () => {
    assert.equal(
      getRawClientIp(raw({ 'x-forwarded-for': '203.0.113.9, 172.16.0.1' })),
      '172.16.0.1'
    );
  });
});

test('two clients behind one proxy do not collapse onto the same key', () => {
  withEnv({ TRUST_PROXY: '1', CLIENT_IP_HEADER: undefined }, () => {
    const a = getRawClientIp(raw({ 'x-forwarded-for': '203.0.113.1' }));
    const b = getRawClientIp(raw({ 'x-forwarded-for': '203.0.113.2' }));
    assert.notEqual(a, b);
    assert.notEqual(a, SOCKET);
  });
});

test('the socket peer is the last resort, not the first', () => {
  withEnv({ TRUST_PROXY: '1', CLIENT_IP_HEADER: undefined }, () => {
    assert.equal(getRawClientIp(raw({})), SOCKET);
  });
});

test('x-real-ip still wins, because Traefik overwrites it', () => {
  withEnv({ TRUST_PROXY: '1', CLIENT_IP_HEADER: undefined }, () => {
    const req = raw({ 'x-real-ip': '198.51.100.7', 'x-forwarded-for': '203.0.113.1' });
    assert.equal(getRawClientIp(req), '198.51.100.7');
    assert.equal(getClientIp(req), '198.51.100.7');
  });
});

test('CLIENT_IP_HEADER is ignored unless it is set, and wins when it is', () => {
  const headers = { 'cf-connecting-ip': '203.0.113.50', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' };
  withEnv({ TRUST_PROXY: '1', CLIENT_IP_HEADER: undefined }, () => {
    assert.equal(getRawClientIp(raw(headers)), '2.2.2.2');
  });
  withEnv({ TRUST_PROXY: '1', CLIENT_IP_HEADER: 'CF-Connecting-IP' }, () => {
    assert.equal(getRawClientIp(raw(headers)), '203.0.113.50');
  });
});

test('TRUST_PROXY=0 refuses to read forwarded-for at all', () => {
  withEnv({ TRUST_PROXY: '0', CLIENT_IP_HEADER: undefined }, () => {
    assert.equal(getRawClientIp(raw({ 'x-forwarded-for': '203.0.113.1' })), SOCKET);
  });
});

test('a garbage TRUST_PROXY falls back to one hop rather than to nothing', () => {
  withEnv({ TRUST_PROXY: 'uniquelocal', CLIENT_IP_HEADER: undefined }, () => {
    assert.equal(
      getRawClientIp(raw({ 'x-forwarded-for': '203.0.113.1, 172.16.0.1' })),
      '172.16.0.1'
    );
  });
});
