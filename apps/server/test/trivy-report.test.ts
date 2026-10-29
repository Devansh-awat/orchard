import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapTrivyReport, summaryFromStored } from '../src/security/trivy-report';

const report = {
  Trivy: { Version: '0.58.1' },
  Metadata: { RepoDigests: [`registry.example.com/orchard/api@sha256:${'a'.repeat(64)}`] },
  Results: [
    {
      Vulnerabilities: [
        {
          VulnerabilityID: 'CVE-2024-0001',
          PkgName: 'openssl',
          InstalledVersion: '3.0.1',
          FixedVersion: '3.0.2',
          Severity: 'HIGH',
          Title: 'openssl: buffer overflow',
          PrimaryURL: 'https://avd.aquasec.com/nvd/cve-2024-0001',
          CVSS: { nvd: { V3Score: 7.5 }, redhat: { V3Score: 8.1 } }
        },
        {
          VulnerabilityID: 'CVE-2024-0001',
          PkgName: 'openssl',
          InstalledVersion: '3.0.1',
          Severity: 'HIGH'
        },
        { VulnerabilityID: 'CVE-2024-0002', PkgName: 'zlib', InstalledVersion: '1.2', Severity: 'CRITICAL' },
        { VulnerabilityID: '', PkgName: 'x' }
      ]
    },
    { Vulnerabilities: null },
    { Vulnerabilities: [{ VulnerabilityID: 'GHSA-1', PkgName: 'lodash', InstalledVersion: '4.0.0', Severity: 'medium' }] }
  ]
};

test('trivy findings map onto the tab shape, deduped and worst first', () => {
  const mapped = mapTrivyReport(report);
  assert.deepEqual(
    mapped.vulnerabilities.map((v) => `${v.severity}:${v.id}:${v.package}`),
    ['critical:CVE-2024-0002:zlib', 'high:CVE-2024-0001:openssl', 'medium:GHSA-1:lodash']
  );
  const openssl = mapped.vulnerabilities[1];
  assert.equal(openssl.fixVersion, '3.0.2');
  assert.equal(openssl.cvss, 8.1);
  assert.equal(openssl.url, 'https://avd.aquasec.com/nvd/cve-2024-0001');
  assert.equal(openssl.description, 'openssl: buffer overflow');
  assert.equal(mapped.digest, `sha256:${'a'.repeat(64)}`);
  assert.equal(mapped.scannerVersion, '0.58.1');
  assert.equal(mapped.counts.total, 3);
  assert.equal(mapped.counts.fixable, 1);
});

test('a clean image and junk input both read as clean', () => {
  assert.equal(mapTrivyReport({ Results: [] }).counts.total, 0);
  assert.equal(mapTrivyReport(null).counts.total, 0);
  const summary = summaryFromStored(mapTrivyReport({}), { startedAt: null, finishedAt: new Date(0) });
  assert.equal(summary.state, 'clean');
  assert.equal(summary.scanner?.name, 'Trivy');
});

test('the summary carries the worst severity', () => {
  const s = summaryFromStored(mapTrivyReport(report), { startedAt: new Date(0), finishedAt: new Date(1000) });
  assert.equal(s.state, 'vulnerable');
  assert.equal(s.severity, 'critical');
});

test('stored rows read back as the tab expects', async () => {
  const { scanFromRow } = await import('../src/security/trivy-report');
  const base = {
    digest: null,
    report: null,
    error: null,
    createdAt: new Date(1_000),
    startedAt: new Date(1_000),
    finishedAt: null
  };
  assert.equal(scanFromRow(null, 60_000, 2_000).summary.state, 'not_scanned');
  assert.equal(scanFromRow({ ...base, status: 'running' }, 60_000, 2_000).summary.state, 'scanning');
  const stale = scanFromRow({ ...base, status: 'running' }, 60_000, 100_000);
  assert.equal(stale.summary.state, 'failed');
  assert.equal(stale.error, 'The scan stopped responding');
  const failed = scanFromRow({ ...base, status: 'failed', error: 'unauthorized' }, 60_000, 2_000);
  assert.equal(failed.error, 'unauthorized');
  const done = scanFromRow(
    { ...base, status: 'done', report: mapTrivyReport(report), finishedAt: new Date(5_000) },
    60_000,
    9_000
  );
  assert.equal(done.summary.state, 'vulnerable');
  assert.equal(done.vulnerabilities?.length, 3);
  assert.equal(done.digest, `sha256:${'a'.repeat(64)}`);
});

test('trivy failures keep only the fatal line', async () => {
  const { trivyErrorMessage } = await import('../src/security/trivy-report');
  assert.equal(
    trivyErrorMessage(
      '2026-10-29T10:00:00Z INFO Vulnerability scanning is enabled 2026-10-29T10:00:01Z FATAL Fatal error unable to find the image: UNAUTHORIZED'
    ),
    'unable to find the image: UNAUTHORIZED'
  );
  assert.equal(trivyErrorMessage('   '), 'The scanner exited with an error');
});
