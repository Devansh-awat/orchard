import test from 'node:test';
import assert from 'node:assert/strict';
import proxyaddr from 'proxy-addr';
import { getClientIp, getRawClientIp } from '../src/auth/client-ip';

const POD = '10.244.2.22';
const CLIENT = '148.241.225.10';
const CF_EDGE = '172.71.164.128';

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const keys = ['TRUST_PROXY', 'TRUSTED_PROXY_RANGES', 'TRUST_CLOUDFLARE', ...Object.keys(vars)];
  const previous: Record<string, string | undefined> = {};
  for (const k of keys) previous[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function req(headers: Record<string, string>, socket = POD) {
  return { headers, socket: { remoteAddress: socket } } as any;
}

const xff = (...parts: string[]) => ({ 'x-forwarded-for': parts.join(', ') });

test('self-hosted behind only an in-cluster ingress needs no configuration', () => {
  withEnv({}, () => {
    assert.equal(getRawClientIp(req(xff(CLIENT))), CLIENT);
    assert.equal(getClientIp(req(xff(CLIENT))), CLIENT);
  });
});

test('behind Cloudflare and HAProxy it finds the caller, not the edge', () => {
  withEnv({}, () => {
    const r = req(xff('203.0.113.77', CLIENT, CF_EDGE));
    assert.equal(getRawClientIp(r), CLIENT);
    assert.equal(getClientIp(r), CLIENT);
  });
});

test('a caller who sent no forwarded-for of their own is still found', () => {
  withEnv({}, () => {
    assert.equal(getRawClientIp(req(xff(CLIENT, CF_EDGE))), CLIENT);
  });
});

test('a forged header cannot reach past what our own proxies appended', () => {
  withEnv({}, () => {
    const spoofed = req({
      ...xff('1.2.3.4', CLIENT, CF_EDGE),
      'cf-connecting-ip': '9.9.9.9',
      'x-real-ip': '8.8.8.8'
    });
    assert.equal(getRawClientIp(spoofed), CLIENT);
  });
});

test('reaching the origin directly gets the caller their own address', () => {
  withEnv({}, () => {
    const direct = req({ ...xff('203.0.113.77', CLIENT), 'cf-connecting-ip': '9.9.9.9' });
    assert.equal(getRawClientIp(direct), CLIENT, 'a forged CF header must not be believed');
  });
});

test('CF-Connecting-IP is read only once Cloudflare is proven, as a last resort', () => {
  withEnv({}, () => {
    const viaCf = req({ ...xff(CF_EDGE), 'cf-connecting-ip': CLIENT });
    assert.equal(getRawClientIp(viaCf), CLIENT);
  });
  withEnv({ TRUST_CLOUDFLARE: 'false' }, () => {
    const viaCf = req({ ...xff(CF_EDGE), 'cf-connecting-ip': CLIENT });
    assert.equal(getRawClientIp(viaCf), CF_EDGE, 'opting out means the edge is the caller');
  });
});

test('two callers behind one proxy get two keys', () => {
  withEnv({}, () => {
    const a = getRawClientIp(req(xff('203.0.113.1', CF_EDGE)));
    const b = getRawClientIp(req(xff('203.0.113.2', CF_EDGE)));
    assert.notEqual(a, b);
    assert.notEqual(a, POD);
    assert.notEqual(a, CF_EDGE);
  });
});

test('no proxy at all means the socket peer, and no headers to read', () => {
  withEnv({}, () => {
    assert.equal(getRawClientIp(req({}, '203.0.113.9')), '203.0.113.9');
  });
});

test('an all-private chain settles for the furthest hop rather than nothing', () => {
  withEnv({}, () => {
    assert.equal(getRawClientIp(req(xff('10.1.2.3'))), '10.1.2.3');
    assert.equal(getRawClientIp(req({})), POD);
  });
});

test('x-real-ip is a fallback, so Traefik behind a CDN is not misread', () => {
  withEnv({}, () => {
    assert.equal(getRawClientIp(req({ 'x-real-ip': CLIENT })), CLIENT);
    const behindCdn = req({ ...xff(CLIENT, CF_EDGE), 'x-real-ip': CF_EDGE });
    assert.equal(getRawClientIp(behindCdn), CLIENT, 'the chain beats a proxy-set x-real-ip');
  });
});

test('TRUSTED_PROXY_RANGES teaches it a proxy it does not ship with', () => {
  withEnv({}, () => {
    assert.equal(getRawClientIp(req(xff(CLIENT, '198.51.100.7'))), '198.51.100.7');
  });
  withEnv({ TRUSTED_PROXY_RANGES: '198.51.100.0/24' }, () => {
    assert.equal(getRawClientIp(req(xff(CLIENT, '198.51.100.7'))), CLIENT);
  });
});

test('IPv6 callers and IPv6 Cloudflare edges both resolve', () => {
  withEnv({}, () => {
    assert.equal(getRawClientIp(req(xff('2001:db8::1', '2606:4700::1'))), '2001:db8::1');
  });
});

test('an explicit TRUST_PROXY still pins the hop count, matching Express', () => {
  const cases: [string, number][] = [
    ['1.1.1.1', 1],
    ['1.1.1.1, 2.2.2.2', 1],
    ['1.1.1.1, 2.2.2.2, 3.3.3.3', 2]
  ];
  for (const [value, hops] of cases) {
    withEnv({ TRUST_PROXY: String(hops) }, () => {
      const r = req({ 'x-forwarded-for': value });
      r.connection = r.socket;
      const expected = proxyaddr(r, (_addr: string, i: number) => i < hops);
      assert.equal(getRawClientIp(r), expected, `${value} @ ${hops}`);
    });
  }
});

test('TRUST_PROXY=0 refuses to read forwarded-for at all', () => {
  withEnv({ TRUST_PROXY: '0' }, () => {
    assert.equal(getRawClientIp(req(xff('203.0.113.1', CF_EDGE))), POD);
  });
});

test('a header stuffed with entries cannot be used to burn cpu', () => {
  withEnv({}, () => {
    const many = Array.from({ length: 5000 }, (_, i) => `203.0.113.${i % 250}`);
    const started = Date.now();
    getRawClientIp(req(xff(...many, CF_EDGE)));
    assert.ok(Date.now() - started < 200, 'derivation must stay cheap');
  });
});

test('a bare install with no proxy at all believes nobody', () => {
  withEnv({}, () => {
    const direct = { headers: {}, socket: { remoteAddress: '203.0.113.9' } } as any;
    assert.equal(getRawClientIp(direct), '203.0.113.9');

    const lying = {
      headers: {
        'x-forwarded-for': '1.2.3.4',
        'x-real-ip': '5.6.7.8',
        'cf-connecting-ip': '9.9.9.9'
      },
      socket: { remoteAddress: '203.0.113.9' }
    } as any;
    assert.equal(getRawClientIp(lying), '203.0.113.9', 'headers from the caller are worthless');
  });
});

test('nginx or caddy on the same host, no cdn', () => {
  withEnv({}, () => {
    const viaLoopback = {
      headers: xff('203.0.113.9'),
      socket: { remoteAddress: '127.0.0.1' }
    } as any;
    assert.equal(getRawClientIp(viaLoopback), '203.0.113.9');
  });
});

test('any in-cluster ingress controller, no cdn', () => {
  withEnv({}, () => {
    for (const peer of ['10.244.2.22', '172.17.0.5', '192.168.1.40', '100.64.0.7', 'fd00::1']) {
      const r = { headers: xff('203.0.113.9'), socket: { remoteAddress: peer } } as any;
      assert.equal(getRawClientIp(r), '203.0.113.9', `peer ${peer}`);
    }
  });
});

test('a proxy that does not append forwarded-for cannot be told from a caller that forged one', () => {
  withEnv({}, () => {
    const r = {
      headers: { 'x-forwarded-for': '1.2.3.4' },
      socket: { remoteAddress: '10.244.2.22' }
    } as any;
    assert.equal(getRawClientIp(r), '1.2.3.4', 'undecidable, and what the hop count said too');
  });
});

test('a reverse proxy on a public address is the one case that needs telling', () => {
  const LB = '203.0.113.200';
  const CALLER = '198.18.55.9';
  withEnv({}, () => {
    const r = { headers: xff(CALLER), socket: { remoteAddress: LB } } as any;
    assert.equal(
      getRawClientIp(r),
      LB,
      'undeclared public proxies are indistinguishable from callers'
    );
  });
  withEnv({ TRUSTED_PROXY_RANGES: `${LB}/32` }, () => {
    const r = { headers: xff(CALLER), socket: { remoteAddress: LB } } as any;
    assert.equal(getRawClientIp(r), CALLER);
  });
});

test('an instance with no cloudflare never consults cloudflare headers', () => {
  withEnv({}, () => {
    const r = {
      headers: { ...xff('203.0.113.9'), 'cf-connecting-ip': '9.9.9.9' },
      socket: { remoteAddress: '10.244.2.22' }
    } as any;
    assert.equal(getRawClientIp(r), '203.0.113.9');
  });
});
