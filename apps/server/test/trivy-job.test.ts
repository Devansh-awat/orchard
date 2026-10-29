import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCAN_LABEL,
  scanJobFailure,
  scanJobManifest,
  scanJobName,
  scanSecretManifest,
  scanTarget
} from '../src/security/trivy-job';
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
  assert.equal(scanJobFailure(cond('Failed', 'BackoffLimitExceeded')), 'The scanner exited with an error');
  assert.equal(
    scanJobFailure(cond('Complete')),
    'The scan finished without reporting a result'
  );
});
