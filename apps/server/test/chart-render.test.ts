import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const chart = resolve(__dirname, '../../../infra/charts/orchard');

function helmAvailable(): boolean {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function render(sets: string[]): string {
  const args = ['template', 'orchard', chart, '--namespace', 'orchard'];
  for (const s of sets) args.push('--set', s);
  return execFileSync('helm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function docs(yaml: string): string[] {
  return yaml.split(/^---$/m);
}

test(
  'the server ClusterRole no longer carries escalate, and binds only the tenant-secrets ClusterRole',
  { skip: !helmAvailable() },
  () => {
    const out = render([]);
    const serverRole = docs(out).find(
      (d) => d.includes('kind: ClusterRole') && d.includes('name: orchard-server\n')
    );
    assert.ok(serverRole, 'server ClusterRole rendered');
    assert.ok(!serverRole.includes('escalate'), 'no escalate verb');
    assert.match(
      serverRole,
      /resources: \["clusterroles"\]\s+verbs: \["bind"\]\s+resourceNames: \["orchard-tenant-secrets"\]/
    );
    assert.match(
      serverRole,
      /resources: \["events"\]\s+verbs: \["get", "list", "watch", "create", "patch"\]/
    );
    const tenantRole = docs(out).find(
      (d) => d.includes('kind: ClusterRole') && d.includes('name: orchard-tenant-secrets')
    );
    assert.ok(tenantRole, 'tenant-secrets ClusterRole rendered');
    assert.match(tenantRole, /resources: \["secrets", "configmaps"\]/);
    assert.match(out, /TENANT_SECRETS_CLUSTER_ROLE, value: "orchard-tenant-secrets"/);
  }
);

test(
  'the backup proxy gets its own postgres role instead of the app owner',
  { skip: !helmAvailable() },
  () => {
    const out = render(['r2Proxy.enabled=true', 'r2Proxy.databasePassword=pw-for-test']);
    const cluster = docs(out).find((d) => /^kind: Cluster$/m.test(d));
    assert.ok(cluster, 'cnpg cluster rendered');
    assert.match(cluster, /name: orchard_r2_proxy/);
    assert.match(cluster, /name: orchard-r2-proxy-db/);
    const credential = docs(out).find(
      (d) => d.includes('name: orchard-r2-proxy-db') && d.includes('kind: Secret')
    );
    assert.ok(credential, 'credential secret rendered');
    assert.match(credential, /password: "pw-for-test"/);
    const dbSecret = docs(out).find((d) => d.includes('name: r2-proxy-db'));
    assert.ok(dbSecret, 'proxy db secret rendered');
    assert.match(
      dbSecret,
      /postgresql:\/\/orchard_r2_proxy:pw-for-test@orchard-db-r\.orchard\.svc\.cluster\.local:5432\/orchard/
    );
    assert.ok(!dbSecret.includes('orchard-db-app'), 'app owner secret is not cloned');
  }
);

test('an explicit proxy database url still wins', { skip: !helmAvailable() }, () => {
  const out = render([
    'r2Proxy.enabled=true',
    'r2Proxy.databaseUrl=postgresql://ro@elsewhere/orchard'
  ]);
  const dbSecret = docs(out).find((d) => d.includes('name: r2-proxy-db'));
  assert.match(dbSecret ?? '', /postgresql:\/\/ro@elsewhere\/orchard/);
});

test('buildkit only trusts plaintext registries from values', { skip: !helmAvailable() }, () => {
  const out = render([
    'builders.httpRegistries[0]=harbor-core.harbor.svc.cluster.local',
    'builders.httpRegistries[1]=zot.orchard.svc.cluster.local:5000'
  ]);
  assert.ok(!out.includes('178.156.144.127'), 'no hardcoded registry ip');
  assert.match(out, /\[registry\."harbor-core\.harbor\.svc\.cluster\.local"\]\s+http = true/);
  assert.match(out, /\[registry\."zot\.orchard\.svc\.cluster\.local:5000"\]\s+http = true/);
});

test('the chart lints clean', { skip: !helmAvailable() }, () => {
  execFileSync('helm', ['lint', chart], { stdio: 'ignore' });
});

test('sandbox runner values render nothing until set', { skip: !helmAvailable() }, () => {
  const out = render([]);
  assert.doesNotMatch(out, /SANDBOX_(RUNNER|VERCEL|DEFAULT_RUNNER|BRIDGE|PREVIEW)_/);
});

test(
  'sandbox runner values become env vars and the vercel token comes from a secret',
  { skip: !helmAvailable() },
  () => {
    const out = render([
      'sandbox.runners.default=vercel',
      'sandbox.runners.kubernetes.enabled=false',
      'sandbox.runners.vercel.enabled=true',
      'sandbox.runners.vercel.tokenSecret.name=vercel-sandbox',
      'sandbox.runners.vercel.teamId=team_1',
      'sandbox.runners.vercel.projectId=prj_1',
      'sandbox.runners.vercel.vcpus=4',
      'sandbox.runners.vercel.timeoutMinutes=90',
      'sandbox.runners.bridgeBinaryUrl=https://example.com/orchard.tar.gz',
      'sandbox.runners.previewDomain=preview.example.com'
    ]);
    assert.match(out, /SANDBOX_RUNNER_KUBERNETES_ENABLED, value: "false"/);
    assert.match(out, /SANDBOX_RUNNER_VERCEL_ENABLED, value: "true"/);
    assert.match(out, /SANDBOX_DEFAULT_RUNNER, value: "vercel"/);
    assert.match(
      out,
      /name: SANDBOX_VERCEL_TOKEN\s+valueFrom:\s+secretKeyRef:\s+name: "vercel-sandbox"\s+key: "token"/
    );
    assert.match(out, /SANDBOX_VERCEL_TEAM_ID, value: "team_1"/);
    assert.match(out, /SANDBOX_VERCEL_PROJECT_ID, value: "prj_1"/);
    assert.match(out, /SANDBOX_VERCEL_VCPUS, value: "4"/);
    assert.match(out, /SANDBOX_VERCEL_TIMEOUT_MINUTES, value: "90"/);
    assert.match(out, /SANDBOX_BRIDGE_BINARY_URL, value: "https:\/\/example.com\/orchard.tar.gz"/);
    assert.match(out, /SANDBOX_PREVIEW_DOMAIN, value: "preview.example.com"/);
    assert.doesNotMatch(out, /SANDBOX_VERCEL_TOKEN, value:/);
  }
);
