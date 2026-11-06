import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getClientIp,
  getRawClientIp,
  isCollapsedAddress,
  parseTrustProxy,
  trustProxySetting
} from '../src/auth/client-ip';

const INGRESS = '10.244.2.22';
const CLIENT = '148.241.225.10';
const CF_EDGE = '172.71.164.128';
const TENANT_POD = '10.244.9.9';
const CLOUDFLARED = '10.244.5.5';

const ENV_KEYS = [
  'TRUST_PROXY',
  'TRUSTED_PROXY_RANGES',
  'TRUST_CLOUDFLARE',
  'CLIENT_IP_HEADER',
  'CLIENT_IP_HEADER_FROM'
];

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const previous: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) previous[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  if (!('TRUST_PROXY' in vars)) process.env.TRUST_PROXY = '1';
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

function req(headers: Record<string, string>, socket = INGRESS) {
  return { headers, socket: { remoteAddress: socket } } as any;
}

const xff = (...parts: string[]) => ({ 'x-forwarded-for': parts.join(', ') });

test('unset TRUST_PROXY fails closed: only the socket peer is believed', () => {
  withEnv({ TRUST_PROXY: undefined }, () => {
    assert.equal(getRawClientIp(req(xff(CLIENT, '1.2.3.4'))), INGRESS);
    assert.equal(parseTrustProxy(undefined).hops, 0);
  });
});

test('TRUST_PROXY=1 trusts exactly one hop: the ingress appended the caller', () => {
  withEnv({}, () => {
    assert.equal(getRawClientIp(req(xff(CLIENT))), CLIENT);
    assert.equal(getClientIp(req(xff(CLIENT))), CLIENT);
  });
});

test('a forged left-hand entry cannot reach past the hop the proxy appended', () => {
  withEnv({}, () => {
    assert.equal(getRawClientIp(req(xff('1.2.3.4', CLIENT))), CLIENT);
  });
});

test('a private caller is the caller, not a proxy to skip', () => {
  withEnv({}, () => {
    const r = req({ ...xff('9.9.9.9', TENANT_POD), 'x-real-ip': '8.8.8.8' });
    assert.equal(getRawClientIp(r), TENANT_POD);
  });
});

test('a tenant pod cannot choose the key by forging x-forwarded-for and x-real-ip', () => {
  withEnv({}, () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const r = req({ ...xff(`203.0.113.${i}`, TENANT_POD), 'x-real-ip': `198.51.100.${i}` });
      seen.add(getRawClientIp(r));
    }
    assert.deepEqual([...seen], [TENANT_POD]);
  });
});

test('an all-private chain never consults x-real-ip', () => {
  withEnv({}, () => {
    assert.equal(getRawClientIp(req({ 'x-real-ip': CLIENT })), INGRESS);
  });
});

test('behind Cloudflare and an ingress it finds the caller, not the edge', () => {
  withEnv({}, () => {
    const r = req(xff('203.0.113.77', CLIENT, CF_EDGE));
    assert.equal(getRawClientIp(r), CLIENT);
  });
});

test('a direct hit gets the socket address and no header is believed', () => {
  withEnv({ TRUST_PROXY: '0' }, () => {
    const r = req({ ...xff('1.2.3.4'), 'x-real-ip': '5.6.7.8', 'cf-connecting-ip': '9.9.9.9' });
    assert.equal(getRawClientIp(r), INGRESS);
  });
  withEnv({ TRUST_PROXY: 'false' }, () => {
    assert.equal(getRawClientIp(req(xff('1.2.3.4'), '203.0.113.9')), '203.0.113.9');
  });
});

test('TRUST_PROXY as a hop count walks from the right', () => {
  const chain = xff('7.7.7.7', '1.1.1.1', '2.2.2.2');
  withEnv({ TRUST_PROXY: '1' }, () => assert.equal(getRawClientIp(req(chain)), '2.2.2.2'));
  withEnv({ TRUST_PROXY: '2' }, () => assert.equal(getRawClientIp(req(chain)), '1.1.1.1'));
  withEnv({ TRUST_PROXY: '3' }, () => assert.equal(getRawClientIp(req(chain)), '7.7.7.7'));
});

test('TRUST_PROXY as a CIDR list trusts only those peers', () => {
  withEnv({ TRUST_PROXY: '10.244.2.0/24' }, () => {
    assert.equal(getRawClientIp(req(xff(CLIENT))), CLIENT);
    assert.equal(getRawClientIp(req(xff('1.2.3.4'), TENANT_POD)), TENANT_POD);
    assert.equal(getRawClientIp(req(xff(CLIENT, '10.244.2.50'))), CLIENT);
  });
});

test('TRUST_PROXY parsing', () => {
  assert.equal(parseTrustProxy(undefined).hops, 0);
  assert.equal(parseTrustProxy('1').hops, 1);
  assert.equal(parseTrustProxy('0').hops, 0);
  assert.equal(parseTrustProxy('false').hops, 0);
  assert.equal(parseTrustProxy('2').hops, 2);
  assert.equal(parseTrustProxy('10.0.0.0/8, 192.0.2.1').ranges.length, 2);
  assert.equal(parseTrustProxy('garbage').hops, 0);
  withEnv({ TRUST_PROXY: '2' }, () => assert.equal(trustProxySetting(), 2));
  withEnv({ TRUST_PROXY: '0' }, () => assert.equal(trustProxySetting(), false));
  withEnv({ TRUST_PROXY: '10.0.0.0/8,192.0.2.1' }, () =>
    assert.deepEqual(trustProxySetting(), ['10.0.0.0/8', '192.0.2.1/32'])
  );
});

test('TRUSTED_PROXY_RANGES adds explicit extra proxies', () => {
  withEnv({}, () => {
    assert.equal(getRawClientIp(req(xff(CLIENT, '198.51.100.7'))), '198.51.100.7');
  });
  withEnv({ TRUSTED_PROXY_RANGES: '198.51.100.0/24' }, () => {
    assert.equal(getRawClientIp(req(xff(CLIENT, '198.51.100.7'))), CLIENT);
  });
});

test('CF-Connecting-IP is only a last resort once Cloudflare is proven', () => {
  withEnv({}, () => {
    const viaCf = req({ ...xff(CF_EDGE), 'cf-connecting-ip': CLIENT });
    assert.equal(getRawClientIp(viaCf), CLIENT);
    const forged = req({ ...xff(CLIENT), 'cf-connecting-ip': '9.9.9.9' });
    assert.equal(getRawClientIp(forged), CLIENT);
  });
  withEnv({ TRUST_CLOUDFLARE: 'false' }, () => {
    const viaCf = req({ ...xff(CF_EDGE), 'cf-connecting-ip': CLIENT });
    assert.equal(getRawClientIp(viaCf), CF_EDGE);
  });
});

test('tunnel mode: the header is honoured only when the tunnel hop is the one that connected', () => {
  const env = {
    CLIENT_IP_HEADER: 'CF-Connecting-IP',
    CLIENT_IP_HEADER_FROM: '10.244.5.0/24'
  };
  withEnv(env, () => {
    const viaTunnel = req({ ...xff(CLOUDFLARED), 'cf-connecting-ip': CLIENT });
    assert.equal(getRawClientIp(viaTunnel), CLIENT);

    const otherPod = req({ ...xff(TENANT_POD), 'cf-connecting-ip': '9.9.9.9' });
    assert.equal(getRawClientIp(otherPod), TENANT_POD);

    const noHeader = req(xff(CLOUDFLARED));
    assert.equal(getRawClientIp(noHeader), CLOUDFLARED);

    const junk = req({ ...xff(CLOUDFLARED), 'cf-connecting-ip': 'not-an-ip' });
    assert.equal(getRawClientIp(junk), CLOUDFLARED);
  });
  withEnv({ CLIENT_IP_HEADER: 'cf-connecting-ip' }, () => {
    const noRanges = req({ ...xff(CLOUDFLARED), 'cf-connecting-ip': CLIENT });
    assert.equal(getRawClientIp(noRanges), CLOUDFLARED, 'a header with no proven hop is ignored');
  });
});

test('two visitors through a tunnel get two keys', () => {
  withEnv({ CLIENT_IP_HEADER: 'cf-connecting-ip', CLIENT_IP_HEADER_FROM: '10.244.5.0/24' }, () => {
    const a = getRawClientIp(req({ ...xff(CLOUDFLARED), 'cf-connecting-ip': '203.0.113.1' }));
    const b = getRawClientIp(req({ ...xff(CLOUDFLARED), 'cf-connecting-ip': '203.0.113.2' }));
    assert.notEqual(a, b);
  });
});

test('IPv6 callers and edges resolve', () => {
  withEnv({}, () => {
    assert.equal(getRawClientIp(req(xff('2001:db8::1', '2606:4700::1'))), '2001:db8::1');
  });
});

test('a header stuffed with entries cannot burn cpu', () => {
  withEnv({}, () => {
    const many = Array.from({ length: 5000 }, (_, i) => `203.0.113.${i % 250}`);
    const started = Date.now();
    getRawClientIp(req(xff(...many, CF_EDGE)));
    assert.ok(Date.now() - started < 200);
  });
});

test('collapsed addresses are the non-public ones', () => {
  for (const a of ['10.1.2.3', '127.0.0.1', '::1', '100.64.0.1', 'fd00::1', 'unknown']) {
    assert.equal(isCollapsedAddress(a), true, a);
  }
  for (const a of [CLIENT, '2a00:1450::1']) {
    assert.equal(isCollapsedAddress(a), false, a);
  }
});
