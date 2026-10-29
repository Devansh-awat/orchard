import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeRepository,
  harborImageRef,
  looksLikeSecretName,
  mapVulnerabilities,
  normalizeSeverity,
  pickOverview,
  postureFindings,
  summarizeScan,
  type HarborArtifact
} from '../src/security/security-report';
import { ImageScanCache, SCAN_TTL, type ScanSource } from '../src/security/image-scan-cache';
import { HarborScanError } from '../src/security/harbor-scan.client';

const MIME = 'application/vnd.security.vulnerability.report; version=1.1';
const config = {
  registries: ['harbor.example.dev', 'harbor-core.harbor.svc:80'],
  project: 'orchard'
};

function artifact(overview: Record<string, unknown> | null): HarborArtifact {
  return {
    digest: 'sha256:' + 'a'.repeat(64),
    push_time: '2026-10-27T10:00:00.000Z',
    scan_overview: overview ? { [MIME]: overview } : null
  };
}

test('severities fold into the five Orchard buckets', () => {
  assert.equal(normalizeSeverity('Critical'), 'critical');
  assert.equal(normalizeSeverity('HIGH'), 'high');
  assert.equal(normalizeSeverity('Negligible'), 'low');
  assert.equal(normalizeSeverity('None'), 'unknown');
  assert.equal(normalizeSeverity(undefined), 'unknown');
});

test('a finished scan with findings is vulnerable and counts every bucket', () => {
  const s = summarizeScan(
    pickOverview(
      artifact({
        scan_status: 'Success',
        severity: 'Critical',
        summary: {
          total: 9,
          fixable: 5,
          summary: { Critical: 2, High: 3, Medium: 1, Low: 1, Negligible: 1, Unknown: 1 }
        },
        start_time: '2026-10-27T10:00:00Z',
        end_time: '2026-10-27T10:01:00Z',
        complete_percent: 100,
        scanner: { name: 'Trivy', version: 'v0.56.0' }
      })
    )
  );
  assert.equal(s.state, 'vulnerable');
  assert.equal(s.severity, 'critical');
  assert.deepEqual(s.counts, {
    critical: 2,
    high: 3,
    medium: 1,
    low: 2,
    unknown: 1,
    total: 9,
    fixable: 5
  });
  assert.equal(s.finishedAt, '2026-10-27T10:01:00.000Z');
  assert.deepEqual(s.scanner, { name: 'Trivy', version: 'v0.56.0' });
});

test('a finished scan with nothing found is clean', () => {
  const s = summarizeScan(
    pickOverview(
      artifact({ scan_status: 'Success', summary: { total: 0, fixable: 0, summary: {} } })
    )
  );
  assert.equal(s.state, 'clean');
  assert.equal(s.severity, 'none');
  assert.equal(s.counts.total, 0);
});

test('a scan that errored is failed, never clean', () => {
  const s = summarizeScan(pickOverview(artifact({ scan_status: 'Error' })));
  assert.equal(s.state, 'failed');
  assert.equal(s.counts.total, 0);
});

test('pending, scheduled and running are all scanning, with progress', () => {
  for (const status of ['Pending', 'Scheduled', 'Running']) {
    const s = summarizeScan(pickOverview(artifact({ scan_status: status, complete_percent: 42 })));
    assert.equal(s.state, 'scanning', status);
    assert.equal(s.progress, 42);
  }
});

test('an artifact with no scan overview, or a stopped scan, is not scanned', () => {
  assert.equal(summarizeScan(pickOverview(artifact(null))).state, 'not_scanned');
  assert.equal(
    summarizeScan(pickOverview(artifact({ scan_status: 'Stopped' }))).state,
    'not_scanned'
  );
});

test('the preferred report mime type wins over others', () => {
  const a: HarborArtifact = {
    scan_overview: {
      'application/vnd.scanner.adapter.vuln.report.harbor+json; version=1.0': {
        scan_status: 'Error'
      },
      [MIME]: { scan_status: 'Success', summary: { total: 0 } }
    }
  };
  assert.equal(summarizeScan(pickOverview(a)).state, 'clean');
});

test('vulnerabilities sort by severity, then fixable, then score, and duplicates collapse', () => {
  const list = mapVulnerabilities({
    [MIME]: {
      vulnerabilities: [
        { id: 'CVE-3', package: 'zlib', version: '1.2', severity: 'Medium', links: [] },
        {
          id: 'CVE-1',
          package: 'openssl',
          version: '3.0.1',
          fix_version: '',
          severity: 'Critical',
          preferred_cvss: { score_v3: 9.1 }
        },
        {
          id: 'CVE-2',
          package: 'openssl',
          version: '3.0.1',
          fix_version: '3.0.7',
          severity: 'Critical',
          preferred_cvss: { score_v3: 7.5 },
          links: [
            'http://insecure',
            'https://avd.aquasec.com/nvd/cve-2',
            'https://nvd.nist.gov/vuln/detail/CVE-2'
          ]
        },
        {
          id: 'CVE-2',
          package: 'openssl',
          version: '3.0.1',
          fix_version: '3.0.7',
          severity: 'Critical'
        },
        { id: '', package: 'ghost', severity: 'High' }
      ]
    }
  });
  assert.deepEqual(
    list.map((v) => v.id),
    ['CVE-2', 'CVE-1', 'CVE-3']
  );
  assert.equal(list[0].fixVersion, '3.0.7');
  assert.equal(list[0].url, 'https://nvd.nist.gov/vuln/detail/CVE-2');
  assert.equal(list[1].fixVersion, null);
  assert.equal(list[1].cvss, 9.1);
  assert.equal(list[2].url, null);
});

test('long descriptions are trimmed and whitespace collapsed', () => {
  const [v] = mapVulnerabilities({
    [MIME]: {
      vulnerabilities: [{ id: 'CVE-9', package: 'p', description: `a\n\n${'b'.repeat(900)}` }]
    }
  });
  assert.ok(v.description!.length <= 600);
  assert.ok(v.description!.startsWith('a b'));
});

test('a garbage additions body maps to an empty list', () => {
  assert.deepEqual(mapVulnerabilities(null), []);
  assert.deepEqual(mapVulnerabilities({ [MIME]: { vulnerabilities: 'nope' } }), []);
});

test('only images in the Orchard registry project resolve to a Harbor reference', () => {
  assert.deepEqual(harborImageRef('harbor.example.dev/orchard/ns-web:v1730000000', config), {
    repository: 'ns-web',
    tag: 'v1730000000',
    digest: null,
    reference: 'v1730000000'
  });
  const digest = 'sha256:' + 'b'.repeat(64);
  assert.equal(
    harborImageRef(`harbor.example.dev/orchard/team/app:v1@${digest}`, config)?.reference,
    digest
  );
  assert.equal(harborImageRef('harbor-core.harbor.svc/orchard/app:v2', config)?.repository, 'app');
  assert.equal(harborImageRef('harbor.example.dev/orchard/app', config)?.reference, 'latest');
  assert.equal(harborImageRef('ghcr.io/hackclub/app:latest', config), null);
  assert.equal(harborImageRef('harbor.example.dev/other/app:v1', config), null);
  assert.equal(harborImageRef('nginx', config), null);
  assert.equal(harborImageRef(null, config), null);
});

test('repository names with slashes are encoded twice for Harbor', () => {
  assert.equal(encodeRepository('a/b'), 'a%252Fb');
  assert.equal(encodeRepository('plain'), 'plain');
});

test('secret-looking names are caught and descriptors are not', () => {
  for (const key of [
    'STRIPE_SECRET_KEY',
    'API_KEY',
    'GITHUB_TOKEN',
    'DB_PASSWORD',
    'slack_bot_token',
    'AWS_SECRET_ACCESS_KEY',
    'OPENAI_APIKEY'
  ])
    assert.equal(looksLikeSecretName(key), true, key);
  for (const key of [
    'PORT',
    'NEXT_PUBLIC_API_KEY',
    'STRIPE_PUBLISHABLE_KEY',
    'VITE_FIREBASE_KEY',
    'TOKEN_URL',
    'JWT_SECRET_TTL',
    'PASSWORD_MIN_LENGTH',
    'KEYCLOAK_REALM',
    'OAUTH_CLIENT_ID'
  ])
    assert.equal(looksLikeSecretName(key), false, key);
});

test('posture flags plain secrets, plain http routes and moving tags, in that order', () => {
  const findings = postureFindings({
    envVars: [
      { key: 'STRIPE_SECRET_KEY', value: 'sk_live_123', secret: false },
      { key: 'ADMIN_PASSWORD', value: 'hunter2', secret: false },
      { key: 'SESSION_SECRET', value: 'x', secret: true },
      { key: 'DB_PASSWORD', value: '${{resource.db.password}}', secret: false },
      { key: 'API_TOKEN', value: '', secret: false },
      { key: 'REQUIRE_TOKEN', value: 'true', secret: false },
      { key: 'PORT', value: '3000', secret: false }
    ],
    image: 'ghcr.io/org/app:latest',
    mutableTag: true,
    ingresses: [
      { host: 'app.example.com', tlsEnabled: true },
      { host: 'plain.example.com', tlsEnabled: false },
      { host: 'old.example.com', tlsEnabled: false, redirectTarget: 'https://app.example.com' }
    ]
  });
  assert.deepEqual(findings, [
    { kind: 'plain-secret', severity: 'high', subjects: ['ADMIN_PASSWORD', 'STRIPE_SECRET_KEY'] },
    { kind: 'no-tls', severity: 'medium', subjects: ['plain.example.com'] },
    { kind: 'mutable-tag', severity: 'low', subjects: ['ghcr.io/org/app:latest'] }
  ]);
});

test('posture is empty when nothing is off', () => {
  assert.deepEqual(
    postureFindings({
      envVars: [],
      image: 'ghcr.io/org/app:v1.2.3',
      mutableTag: false,
      ingresses: []
    }),
    []
  );
});

function fakeSource(overrides: Partial<ScanSource> = {}) {
  const calls = { artifact: 0, vulnerabilities: 0, scan: 0 };
  const source: ScanSource = {
    artifact: async () => {
      calls.artifact++;
      return artifact({
        scan_status: 'Success',
        end_time: '2026-10-27T10:00:00Z',
        summary: { total: 1, fixable: 1, summary: { High: 1 } }
      });
    },
    vulnerabilities: async () => {
      calls.vulnerabilities++;
      return {
        [MIME]: {
          vulnerabilities: [
            { id: 'CVE-1', package: 'p', version: '1', fix_version: '2', severity: 'High' }
          ]
        }
      };
    },
    scan: async () => {
      calls.scan++;
      return 'started';
    },
    ...overrides
  };
  return { source, calls };
}

const ref = { repository: 'app', reference: 'v1', tag: 'v1', digest: null };

test('the cache answers repeat reads without calling Harbor again', async () => {
  let now = 1_000_000;
  const { source, calls } = fakeSource();
  const cache = new ImageScanCache(source, () => now);
  const [a, b] = await Promise.all([cache.get(ref), cache.get(ref)]);
  assert.equal(a.summary.state, 'vulnerable');
  assert.equal(b.vulnerabilities?.length, 1);
  assert.equal(calls.artifact, 1);
  now += SCAN_TTL.settled - 1;
  await cache.get(ref);
  assert.equal(calls.artifact, 1);
  now += 2;
  await cache.get(ref);
  assert.equal(calls.artifact, 2);
});

test('a Harbor outage is an error with a reason, never an empty clean list', async () => {
  const { source } = fakeSource({
    artifact: async () => {
      throw new HarborScanError('unreachable', 502, 'bad gateway');
    }
  });
  const scan = await new ImageScanCache(source).get(ref);
  assert.equal(scan.summary.state, 'error');
  assert.equal(scan.summary.reason, 'unreachable');
  assert.equal(scan.vulnerabilities, null);
});

test('a list that fails to load keeps the counts and reports no list', async () => {
  const { source } = fakeSource({
    vulnerabilities: async () => {
      throw new HarborScanError('unreachable', 500, 'boom');
    }
  });
  const scan = await new ImageScanCache(source).get(ref);
  assert.equal(scan.summary.state, 'vulnerable');
  assert.equal(scan.summary.counts.high, 1);
  assert.equal(scan.vulnerabilities, null);
});

test('rescans are rate limited and read as scanning until Harbor catches up', async () => {
  let now = Date.parse('2026-10-27T11:00:00Z');
  const { source, calls } = fakeSource();
  const cache = new ImageScanCache(source, () => now);
  const first = await cache.rescan(ref);
  assert.equal(calls.scan, 1);
  assert.equal(first.summary.state, 'scanning');
  now += 1_000;
  await cache.rescan(ref);
  assert.equal(calls.scan, 1);
  now += 60_000;
  const later = await cache.get(ref);
  assert.equal(later.summary.state, 'vulnerable');
});
