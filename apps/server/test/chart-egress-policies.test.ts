import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadAll } from 'js-yaml';

const chart = resolve(__dirname, '../../../infra/charts/orchard');

function helmAvailable(): boolean {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function render(sets: string[]): any[] {
  const args = ['template', 'orchard', chart, '--namespace', 'orchard'];
  for (const s of sets) args.push('--set', s);
  const out = execFileSync('helm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return loadAll(out).filter((d): d is any => !!d && typeof d === 'object');
}

const options = { skip: !helmAvailable() };

const policy = (docs: any[], name: string) =>
  docs.find((d) => d.kind === 'NetworkPolicy' && d.metadata.name === name);

const namespaceOf = (peer: any) =>
  peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'];

const internetRules = (p: any) =>
  p.spec.egress.filter((rule: any) => rule.to?.some((t: any) => t.ipBlock));

test('builders reach Harbor core and the ingress serving ports only', options, () => {
  const docs = render(['builders.enabled=true']);
  const builder = policy(docs, 'builder-network-policy');
  assert.ok(builder);
  const harbor = builder.spec.egress.find((r: any) =>
    r.to?.some((t: any) => namespaceOf(t) === 'harbor')
  );
  assert.deepEqual(harbor.to[0].podSelector.matchLabels, { component: 'core' });
  assert.deepEqual(
    harbor.ports.map((p: any) => p.port),
    [80, 8080]
  );
  const network = builder.spec.egress.find((r: any) =>
    r.to?.some((t: any) => namespaceOf(t) === 'network')
  );
  assert.deepEqual(
    network.ports.map((p: any) => p.port),
    [80, 443, 8000, 8080, 8443]
  );
  assert.ok(!network.ports.some((p: any) => [1024, 6060].includes(p.port)));
  for (const rule of builder.spec.egress) {
    if (rule.to?.some((t: any) => namespaceOf(t)))
      assert.ok(rule.ports?.length, 'no namespace-wide rule');
  }
});

test('every internet rule keeps private ranges out and takes the extra deny list', options, () => {
  const docs = render([
    'builders.enabled=true',
    'trivy.enabled=true',
    'fcBuilder.enabled=true',
    'sandbox.enabled=true',
    'tenant.extraDenyCidrs=203.0.113.7\\,198.51.100.0/24\\,10.9.9.9'
  ]);
  const names = [
    'builder-network-policy',
    'buildkit-daemon-network-policy',
    'image-scan-jobs',
    'fc-builder',
    'sandbox-isolation'
  ];
  for (const name of names) {
    const p = policy(docs, name);
    assert.ok(p, name);
    const rules = internetRules(p);
    assert.ok(rules.length > 0, name);
    for (const rule of rules) {
      const except = rule.to.find((t: any) => t.ipBlock).ipBlock.except;
      for (const cidr of [
        '10.0.0.0/8',
        '172.16.0.0/12',
        '192.168.0.0/16',
        '169.254.0.0/16',
        '100.64.0.0/10'
      ]) {
        assert.ok(except.includes(cidr), `${name} excepts ${cidr}`);
      }
      assert.ok(except.includes('203.0.113.7/32'), `${name} excepts the extra address`);
      assert.ok(except.includes('198.51.100.0/24'), `${name} excepts the extra range`);
      assert.ok(!except.includes('10.9.9.9/32'), `${name} skips addresses already covered`);
    }
  }
});

test(
  'the scan jobs reach DNS, trivy, the server, the registry and the public internet only',
  options,
  () => {
    const docs = render(['trivy.enabled=true']);
    const scan = policy(docs, 'image-scan-jobs');
    assert.ok(scan);
    assert.ok(
      !scan.spec.egress.some((r: any) =>
        r.to?.some((t: any) => t.namespaceSelector && Object.keys(t.namespaceSelector).length === 0)
      )
    );
    const peers = scan.spec.egress.flatMap((r: any) => r.to ?? []);
    const namespaces = peers.map(namespaceOf).filter(Boolean);
    assert.deepEqual([...new Set(namespaces)].sort(), [
      'harbor',
      'kube-system',
      'network',
      'orchard'
    ]);
    const server = scan.spec.egress.find((r: any) =>
      r.to?.some((t: any) => namespaceOf(t) === 'orchard')
    );
    assert.deepEqual(server.to[0].podSelector.matchLabels, { 'app.kubernetes.io/name': 'server' });
    assert.deepEqual(
      server.ports.map((p: any) => p.port),
      [3001]
    );
    const internet = internetRules(scan);
    assert.equal(internet.length, 1);
    assert.equal(internet[0].to[0].ipBlock.except.includes('10.0.0.0/8'), true);
    assert.equal(internet[0].to[0].ipBlock.except.includes('169.254.0.0/16'), true);
  }
);

test(
  'with cilium, the platform namespaces deny host, remote nodes and the apiserver',
  options,
  () => {
    const none = render(['builders.enabled=true']);
    assert.equal(
      none.filter(
        (d) => d.kind === 'CiliumNetworkPolicy' && d.metadata.name === 'deny-platform-egress'
      ).length,
      0
    );
    const docs = render([
      'cilium.enabled=true',
      'builders.enabled=true',
      'trivy.enabled=true',
      'fcBuilder.enabled=true',
      'sandbox.enabled=true'
    ]);
    const denies = docs.filter(
      (d) => d.kind === 'CiliumNetworkPolicy' && d.metadata.name === 'deny-platform-egress'
    );
    assert.deepEqual(denies.map((d) => d.metadata.namespace).sort(), [
      'orchard-builders',
      'orchard-fc-builders',
      'orchard-sandboxes',
      'orchard-scans'
    ]);
    for (const deny of denies) {
      assert.deepEqual(deny.spec.egressDeny[0].toEntities, [
        'host',
        'remote-node',
        'kube-apiserver'
      ]);
    }
    const off = render([
      'cilium.enabled=true',
      'builders.enabled=true',
      'networkPolicy.egressDeny.enabled=false'
    ]);
    assert.equal(off.filter((d) => d.metadata?.name === 'deny-platform-egress').length, 0);
  }
);
