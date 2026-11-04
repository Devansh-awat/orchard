import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SCAN_LABEL,
  scanJobFailure,
  scanJobManifest,
  scanJobName,
  scanSecretManifest,
  scanTarget
} from '../src/security/trivy-job';
import { trivyErrorMessage } from '../src/security/trivy-report';
import { registryAuth } from '../src/docker/registry-pull-auth';

const selfHosted = {
  pullRegistry: 'registry.orchard.local',
  pushRegistry: 'zot.orchard.svc.cluster.local:5000',
  httpHosts: new Set(['zot.orchard.svc.cluster.local:5000'])
};

test('orchard images are scanned through the in-cluster push host', () => {
  assert.deepEqual(scanTarget('registry.orchard.local/orchard/api:abc', selfHosted), {
    ref: 'zot.orchard.svc.cluster.local:5000/orchard/api:abc',
    host: 'zot.orchard.svc.cluster.local:5000',
    insecure: true
  });
  const harbor = {
    pullRegistry: 'registry.example.com',
    pushRegistry: 'harbor-core.harbor.svc.cluster.local',
    httpHosts: new Set(['harbor-core.harbor.svc.cluster.local'])
  };
  assert.equal(
    scanTarget('registry.example.com/orchard/api@sha256:1', harbor).ref,
    'harbor-core.harbor.svc.cluster.local:80/orchard/api@sha256:1'
  );
});

test('external images are scanned where they live', () => {
  assert.deepEqual(scanTarget('ghcr.io/acme/web:1', selfHosted), {
    ref: 'ghcr.io/acme/web:1',
    host: 'ghcr.io',
    insecure: false
  });
  assert.equal(scanTarget('nginx:1.27', selfHosted).host, 'docker.io');
  assert.equal(scanTarget('library/nginx', selfHosted).ref, 'library/nginx');
});

test('the job is locked down and carries its secrets by reference', () => {
  const id = '0f6e1c2a-1111-4222-8333-944455556666';
  const job = scanJobManifest({
    scanId: id,
    namespace: 'orchard-scans',
    trivyImage: 'ghcr.io/aquasecurity/trivy:0.76.1',
    serverUrl: 'http://trivy.orchard-scans.svc:4954',
    resultUrl: `http://server.orchard.svc.cluster.local:3001/apiv1/internal/image-scans/${id}/result`,
    target: scanTarget('registry.orchard.local/orchard/api:abc', selfHosted),
    timeoutSeconds: 900,
    withServerToken: true
  });
  assert.equal(job.metadata?.name, scanJobName(id));
  assert.equal(job.metadata?.labels?.[SCAN_LABEL], id);
  assert.equal(job.spec?.backoffLimit, 0);
  assert.equal(job.spec?.activeDeadlineSeconds, 900);
  const pod = job.spec!.template.spec!;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext?.runAsNonRoot, true);
  const c = pod.containers[0];
  assert.equal(c.securityContext?.readOnlyRootFilesystem, true);
  const env = Object.fromEntries((c.env ?? []).map((e) => [e.name, e]));
  assert.equal(env.SCAN_IMAGE.value, 'zot.orchard.svc.cluster.local:5000/orchard/api:abc');
  assert.equal(env.TRIVY_INSECURE.value, 'true');
  assert.equal(env.SCAN_TOKEN.valueFrom?.secretKeyRef?.key, 'scan-token');
  assert.equal(env.TRIVY_TOKEN.valueFrom?.secretKeyRef?.key, 'trivy-token');
  assert.ok(!JSON.stringify(job).includes('password'));

  const secret = scanSecretManifest(
    { ...job, metadata: { ...job.metadata, uid: 'uid-1' } },
    {
      scanToken: 'tok',
      serverToken: 'srv',
      auths: { 'zot.orchard.svc.cluster.local:5000': registryAuth('orchard', 'pw') }
    }
  );
  assert.equal(secret.metadata?.ownerReferences?.[0].uid, 'uid-1');
  assert.equal(secret.stringData?.['scan-token'], 'tok');
  assert.equal(
    JSON.parse(secret.stringData!['config.json']).auths['zot.orchard.svc.cluster.local:5000']
      .username,
    'orchard'
  );
});

test('job conditions become plain failure reasons', () => {
  const cond = (type: string, reason?: string, message?: string) => ({
    status: { conditions: [{ type, status: 'True', reason, message }] }
  });
  assert.equal(scanJobFailure({}), null);
  assert.equal(scanJobFailure(cond('Failed', 'DeadlineExceeded')), 'The scan ran out of time');
  assert.equal(
    scanJobFailure(cond('Failed', 'BackoffLimitExceeded')),
    'The scanner exited with an error'
  );
  assert.equal(scanJobFailure(cond('Complete')), 'The scan finished without reporting a result');
});

function scanScript(): string {
  const job = scanJobManifest({
    scanId: '0f6e1c2a-1111-4222-8333-944455556666',
    namespace: 'orchard-scans',
    trivyImage: 'ghcr.io/aquasecurity/trivy:0.76.1',
    serverUrl: 'http://trivy:4954',
    resultUrl: 'http://server/result',
    target: scanTarget('nginx:1.27', selfHosted),
    timeoutSeconds: 900,
    withServerToken: false
  });
  return job.spec!.template.spec!.containers[0].command![2];
}

function runScanScript(refusals: number, trivyBody: string) {
  const dir = mkdtempSync(join(tmpdir(), 'scan-script-'));
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub('sleep', 'exit 0');
  stub('trivy', `echo trivy >> "${dir}/calls"\n${trivyBody}`);
  stub(
    'wget',
    [
      'case "$*" in',
      '  *healthz*)',
      `    echo healthz >> "${dir}/calls"`,
      `    [ "$(grep -c healthz "${dir}/calls")" -gt ${refusals} ] && exit 0`,
      '    exit 1 ;;',
      '  *)',
      `    echo post >> "${dir}/calls"`,
      '    while [ $# -gt 0 ]; do',
      `      [ "$1" = "--post-file" ] && cp "$2" "${dir}/posted"`,
      '      shift',
      '    done ;;',
      'esac'
    ].join('\n')
  );
  const run = spawnSync('/bin/sh', ['-c', scanScript().replaceAll('/tmp/', `${dir}/`)], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      TRIVY_SERVER: 'http://trivy:4954',
      RESULT_URL: 'http://server/result',
      SCAN_IMAGE: 'nginx:1.27',
      SCAN_TOKEN: 'tok',
      REPORT: join(dir, 'report.json')
    }
  });
  const posted = existsSync(join(dir, 'posted')) ? readFileSync(join(dir, 'posted'), 'utf8') : '';
  const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');
  rmSync(dir, { recursive: true, force: true });
  return { status: run.status, posted, calls };
}

test('the scan waits for the Trivy server before it starts', () => {
  const { status, posted, calls } = runScanScript(2, `echo '{"Results":[]}' > "$REPORT"`);
  assert.equal(status, 0);
  assert.deepEqual(calls, ['healthz', 'healthz', 'healthz', 'trivy', 'post']);
  assert.deepEqual(JSON.parse(posted), { Results: [] });
});

test('the scan still runs and reports when the Trivy server never answers', () => {
  const { status, posted, calls } = runScanScript(
    1000,
    `echo 'FATAL Fatal error run error: boom' >&2\nexit 1`
  );
  assert.equal(status, 1);
  assert.equal(calls.filter((c) => c === 'healthz').length, 31);
  assert.deepEqual(calls.slice(-2), ['trivy', 'post']);
  assert.equal(trivyErrorMessage(JSON.parse(posted).error), 'run error: boom');
});

test('a failed scan reports readable text', () => {
  const { status, posted } = runScanScript(
    0,
    String.raw`printf 'INFO starting\nFATAL\tFatal error\tunable to "find" the \\ image: \303\251 denied\n' >&2
exit 1`
  );
  assert.equal(status, 1);
  assert.equal(trivyErrorMessage(JSON.parse(posted).error), 'unable to find the image: denied');
});

test('the script avoids tr character classes, which busybox treats as literal text', () => {
  assert.ok(!scanScript().includes('[:'));
});
