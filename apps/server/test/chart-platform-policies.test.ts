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

const find = (docs: any[], kind: string, name: string, namespace?: string) =>
  docs.find(
    (d) =>
      d.kind === kind &&
      d.metadata.name === name &&
      (namespace === undefined || d.metadata.namespace === namespace)
  );

function matches(selector: any, labels: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
    if (labels[key] !== value) return false;
  }
  for (const expr of selector.matchExpressions ?? []) {
    const has = expr.key in labels;
    const inValues = (expr.values ?? []).includes(labels[expr.key]);
    if (expr.operator === 'Exists' && !has) return false;
    if (expr.operator === 'DoesNotExist' && has) return false;
    if (expr.operator === 'In' && !inValues) return false;
    if (expr.operator === 'NotIn' && inValues) return false;
  }
  return true;
}

const namespaceLabels = (name: string, extra: Record<string, string> = {}) => ({
  'kubernetes.io/metadata.name': name,
  ...extra
});

function admits(policy: any, fromNamespace: Record<string, string>): boolean {
  return policy.spec.ingress.some((rule: any) =>
    (rule.from ?? []).some(
      (peer: any) =>
        peer.namespaceSelector &&
        !peer.podSelector &&
        matches(peer.namespaceSelector, fromNamespace)
    )
  );
}

test(
  'platform pods refuse tenants, builds, sandboxes and scans and admit everyone else',
  options,
  () => {
    const docs = render(['metrics.enabled=true', 'trivy.enabled=true']);
    for (const ns of ['orchard', 'orchard-metrics']) {
      const policy = find(docs, 'NetworkPolicy', 'platform-ingress', ns);
      assert.ok(policy, ns);
      assert.deepEqual(policy.spec.policyTypes, ['Ingress']);
      const tenant = namespaceLabels('acme-web', { 'orchard.my/managed': 'true' });
      const legacyTenant = namespaceLabels('old-web', { 'orchard.dev/managed': 'true' });
      for (const untrusted of [
        'orchard-builders',
        'orchard-sandboxes',
        'orchard-fc-builders',
        'orchard-scans'
      ]) {
        assert.equal(admits(policy, namespaceLabels(untrusted)), false, untrusted);
      }
      assert.equal(admits(policy, tenant), false);
      assert.equal(admits(policy, legacyTenant), false);
      for (const platform of [
        'network',
        'traefik',
        'postgresql',
        'monitoring',
        'orchard-metrics',
        'orchard-r2-proxy',
        'kube-system'
      ]) {
        assert.equal(admits(policy, namespaceLabels(platform)), true, platform);
      }
      assert.ok(
        policy.spec.ingress[0].from.some((p: any) => p.podSelector && !p.namespaceSelector)
      );
    }
  }
);

test('redis keeps its own narrower policy', options, () => {
  const docs = render([]);
  const platform = find(docs, 'NetworkPolicy', 'platform-ingress', 'orchard');
  const redisPod = { 'app.kubernetes.io/name': 'redis' };
  assert.equal(matches(platform.spec.podSelector, redisPod), false);
  for (const name of ['server', 'server-worker', 'mcp', 'frontend', 'postgres']) {
    assert.equal(
      matches(platform.spec.podSelector, { 'app.kubernetes.io/name': name }),
      true,
      name
    );
  }
  assert.equal(matches(platform.spec.podSelector, { 'cnpg.io/cluster': 'orchard-db' }), true);
  const redis = find(docs, 'NetworkPolicy', 'redis-ingress');
  const callers = redis.spec.ingress[0].from.map(
    (p: any) => p.podSelector.matchLabels['app.kubernetes.io/name']
  );
  assert.deepEqual(callers, ['server', 'mcp', 'server-worker']);
});

test(
  'image scans can report to the server and reach nothing else in the release namespace',
  options,
  () => {
    const docs = render(['trivy.enabled=true']);
    const allow = find(docs, 'NetworkPolicy', 'platform-allow-image-scan-results');
    assert.deepEqual(allow.spec.podSelector.matchLabels, { 'app.kubernetes.io/name': 'server' });
    const from = allow.spec.ingress[0].from[0];
    assert.equal(
      from.namespaceSelector.matchLabels['kubernetes.io/metadata.name'],
      'orchard-scans'
    );
    assert.deepEqual(from.podSelector.matchLabels, { 'app.kubernetes.io/name': 'image-scan' });
    assert.deepEqual(
      allow.spec.ingress[0].ports.map((p: any) => p.port),
      [3001]
    );
    assert.equal(find(render([]), 'NetworkPolicy', 'platform-allow-image-scan-results'), undefined);
  }
);

test('the policies can be switched off and extra namespaces treated as untrusted', options, () => {
  assert.equal(
    find(render(['networkPolicy.platform.enabled=false']), 'NetworkPolicy', 'platform-ingress'),
    undefined
  );
  const docs = render(['networkPolicy.platform.untrustedNamespaces[0]=contractors']);
  const policy = find(docs, 'NetworkPolicy', 'platform-ingress', 'orchard');
  assert.equal(admits(policy, namespaceLabels('contractors')), false);
});

test('cilium entities are admitted only where cilium policies render', options, () => {
  assert.equal(
    find(render([]), 'CiliumNetworkPolicy', 'platform-allow-cilium-entities'),
    undefined
  );
  const docs = render(['cilium.enabled=true']);
  const cnp = find(docs, 'CiliumNetworkPolicy', 'platform-allow-cilium-entities', 'orchard');
  assert.deepEqual(cnp.spec.ingress[0].fromEntities, ['host', 'remote-node', 'ingress']);
});

test(
  'r2-proxy only takes connections from tenants, builds, the server and the operator',
  options,
  () => {
    const policy = find(render([]), 'NetworkPolicy', 'r2-proxy-ingress');
    const from = policy.spec.ingress[0].from;
    assert.ok(from.length > 0 && from.every((p: any) => p.namespaceSelector));
    const tenant = namespaceLabels('acme-web', { 'orchard.my/managed': 'true' });
    const reaches = (labels: Record<string, string>) =>
      from.some((p: any) => matches(p.namespaceSelector, labels));
    assert.equal(reaches(tenant), true);
    assert.equal(reaches(namespaceLabels('orchard')), true);
    assert.equal(reaches(namespaceLabels('postgresql')), true);
    assert.equal(reaches(namespaceLabels('orchard-builders')), true);
    assert.equal(reaches(namespaceLabels('orchard-sandboxes')), false);
    assert.equal(reaches(namespaceLabels('some-other-namespace')), false);
  }
);

test('redis requires a password that the server receives through the environment', options, () => {
  const docs = render([]);
  const secret = find(docs, 'Secret', 'redis-auth', 'orchard');
  assert.ok(secret.stringData.password.length >= 32);
  const redis = find(docs, 'Deployment', 'redis', 'orchard');
  const container = redis.spec.template.spec.containers[0];
  assert.deepEqual(container.args.slice(-2), ['--requirepass', '$(REDISCLI_AUTH)']);
  assert.equal(
    container.env.find((e: any) => e.name === 'REDISCLI_AUTH').valueFrom.secretKeyRef.name,
    'redis-auth'
  );
  assert.equal(redis.spec.template.spec.automountServiceAccountToken, false);
  const server = find(docs, 'Deployment', 'server', 'orchard');
  const env = server.spec.template.spec.containers[0].env as any[];
  const names = env.map((e) => e.name);
  assert.ok(
    names.indexOf('REDIS_PASSWORD') >= 0 &&
      names.indexOf('REDIS_PASSWORD') < names.indexOf('REDIS_URL')
  );
  assert.equal(
    env.find((e) => e.name === 'REDIS_URL').value,
    'redis://:$(REDIS_PASSWORD)@redis.orchard.svc.cluster.local:6379'
  );
});

test(
  'an operator password is used as given, and an external redis gets no password',
  options,
  () => {
    const pinned = find(
      render(['redis.auth.password=pinned-secret']),
      'Secret',
      'redis-auth',
      'orchard'
    );
    assert.equal(pinned.stringData.password, 'pinned-secret');
    const external = render(['redis.url=redis://managed.example.com:6379']);
    assert.equal(find(external, 'Secret', 'redis-auth'), undefined);
    const server = find(external, 'Deployment', 'server', 'orchard');
    const env = server.spec.template.spec.containers[0].env as any[];
    assert.equal(env.find((e) => e.name === 'REDIS_URL').value, 'redis://managed.example.com:6379');
    assert.equal(
      env.find((e) => e.name === 'REDIS_PASSWORD'),
      undefined
    );
    const off = render(['redis.auth.enabled=false']);
    assert.equal(find(off, 'Secret', 'redis-auth'), undefined);
  }
);
