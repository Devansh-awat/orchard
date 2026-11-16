import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadAll } from 'js-yaml';
import { toolAvailable } from './support/tools';

const chart = resolve(__dirname, '../../../infra/charts/orchard');

function helmAvailable(): boolean {
  return toolAvailable('helm', ['version', '--short']);
}

function render(sets: string[]): any[] {
  const args = ['template', 'orchard', chart, '--namespace', 'orchard'];
  for (const s of sets) args.push('--set', s);
  const out = execFileSync('helm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return loadAll(out).filter((d): d is any => !!d && typeof d === 'object');
}

const options = { skip: !helmAvailable() };

const verbsOn = (role: any, group: string, resource: string) =>
  (role.rules as any[])
    .filter((r) => r.apiGroups?.includes(group) && r.resources?.includes(resource))
    .flatMap((r) => r.verbs);

test('kube-state-metrics can read exactly what it exports', options, () => {
  const docs = render(['metrics.enabled=true']);
  const role = docs.find(
    (d) => d.kind === 'ClusterRole' && d.metadata.name === 'orchard-kube-state-metrics'
  );
  const deployment = docs.find(
    (d) => d.kind === 'Deployment' && d.metadata.name === 'kube-state-metrics'
  );
  assert.ok(role && deployment);
  const flag = deployment.spec.template.spec.containers[0].args.find((a: string) =>
    a.startsWith('--resources=')
  );
  const exported = new Set(flag.slice('--resources='.length).split(','));
  for (const secretLike of ['secrets', 'serviceaccounts', 'configmaps']) {
    assert.ok(!exported.has(secretLike), `${secretLike} is not exported`);
    assert.deepEqual(verbsOn(role, '', secretLike), [], `${secretLike} is not readable`);
  }
  for (const resource of [
    'persistentvolumes',
    'certificatesigningrequests',
    'roles',
    'rolebindings',
    'clusterroles',
    'clusterrolebindings'
  ]) {
    const readable = (role.rules as any[]).some((r) => r.resources?.includes(resource));
    assert.equal(readable, false, `${resource} is not readable`);
  }
  for (const resource of ['pods', 'nodes', 'deployments', 'persistentvolumeclaims']) {
    assert.ok(exported.has(resource));
  }
});

test('vmagent scrapes the kubelet directly and has no nodes/proxy', options, () => {
  const docs = render(['metrics.enabled=true']);
  const role = docs.find((d) => d.kind === 'ClusterRole' && d.metadata.name === 'orchard-vmagent');
  assert.ok(role);
  assert.ok(!(role.rules as any[]).some((r) => r.resources?.includes('nodes/proxy')));
  assert.ok((role.rules as any[]).some((r) => r.resources?.includes('nodes/metrics')));
});

test('node-exporter listens on the node address, not every interface', options, () => {
  const docs = render(['metrics.enabled=true']);
  const daemonSet = docs.find((d) => d.kind === 'DaemonSet' && d.metadata.name === 'node-exporter');
  assert.ok(daemonSet);
  const spec = daemonSet.spec.template.spec;
  const container = spec.containers[0];
  assert.ok(container.args.includes('--web.listen-address=$(HOST_IP):9100'));
  assert.deepEqual(
    container.env.find((e: any) => e.name === 'HOST_IP').valueFrom.fieldRef.fieldPath,
    'status.hostIP'
  );
  assert.equal(spec.hostPID, undefined);
});
