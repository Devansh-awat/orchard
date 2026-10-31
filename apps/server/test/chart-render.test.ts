import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadAll } from 'js-yaml';
import {
  KubernetesSandboxRunner,
  SANDBOX_INGRESS_PORTS
} from '../../../grafts/greenhouse/server/src/sandboxes/runners/kubernetes.runner';
import { PREVIEW_PORTS } from '../../../grafts/greenhouse/server/src/sandboxes/preview/preview-auth';

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
      'sandbox.runners.vercel.driveGiB=120',
      'sandbox.runners.bridgeBinaryUrl=https://example.com/orchard.tar.gz',
      `sandbox.runners.bridgeBinarySha256=${'ab'.repeat(32)}`,
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
    assert.match(out, /SANDBOX_VERCEL_DRIVE_GIB, value: "120"/);
    assert.match(out, /SANDBOX_BRIDGE_BINARY_URL, value: "https:\/\/example.com\/orchard.tar.gz"/);
    assert.match(out, new RegExp(`SANDBOX_BRIDGE_BINARY_SHA256, value: "${'ab'.repeat(32)}"`));
    assert.match(out, /SANDBOX_PREVIEW_DOMAIN, value: "preview.example.com"/);
    assert.doesNotMatch(out, /SANDBOX_VERCEL_TOKEN, value:/);
  }
);

function parsed(yaml: string): any[] {
  return loadAll(yaml).filter((d): d is any => !!d && typeof d === 'object');
}

test(
  'the chart sandbox NetworkPolicy matches the one the server applies',
  { skip: !helmAvailable() },
  () => {
    const out = parsed(render(['sandbox.enabled=true']));
    const chartPolicy = out.find(
      (d) => d.kind === 'NetworkPolicy' && d.metadata?.name === 'sandbox-isolation'
    );
    assert.ok(chartPolicy, 'chart renders sandbox-isolation');
    const saved = {
      ns: process.env.SANDBOX_NAMESPACE,
      server: process.env.ORCHARD_SERVER_NAMESPACE
    };
    delete process.env.SANDBOX_NAMESPACE;
    delete process.env.ORCHARD_SERVER_NAMESPACE;
    try {
      const runner = Object.create(KubernetesSandboxRunner.prototype) as KubernetesSandboxRunner;
      const serverPolicy = JSON.parse(JSON.stringify(runner.networkPolicyManifest())) as any;
      assert.equal(chartPolicy.metadata.namespace, serverPolicy.metadata.namespace);
      assert.deepEqual(chartPolicy.spec, serverPolicy.spec);
      const ports = chartPolicy.spec.ingress[0].ports.map((p: any) => p.port);
      assert.deepEqual(ports, [...SANDBOX_INGRESS_PORTS]);
      for (const port of PREVIEW_PORTS) assert.ok(ports.includes(port), `preview port ${port}`);
    } finally {
      if (saved.ns !== undefined) process.env.SANDBOX_NAMESPACE = saved.ns;
      if (saved.server !== undefined) process.env.ORCHARD_SERVER_NAMESPACE = saved.server;
    }
  }
);

test(
  'sandbox previews render no route until a preview domain is set',
  { skip: !helmAvailable() },
  () => {
    const out = parsed(render(['sandbox.enabled=true']));
    assert.ok(!out.some((d) => d.metadata?.name === 'orchard-sandbox-previews'));
  }
);

test(
  'a preview domain renders a wildcard route to the server and a certificate',
  { skip: !helmAvailable() },
  () => {
    const out = parsed(
      render([
        'sandbox.runners.previewDomain=Preview.Example.com',
        'ingress.entryPoints[0]=websecure',
        'ingress.entryPoints[1]=web'
      ])
    );
    const route = out.find(
      (d) => d.kind === 'IngressRoute' && d.metadata?.name === 'orchard-sandbox-previews'
    );
    assert.ok(route, 'preview IngressRoute rendered');
    assert.deepEqual(route.spec.entryPoints, ['websecure', 'web']);
    assert.equal(
      route.spec.routes[0].match,
      'HostRegexp(`^[0-9]{2,5}-[0-9a-f]{8}\\.preview\\.example\\.com$`)'
    );
    assert.deepEqual(route.spec.routes[0].services, [{ name: 'server', port: 3001 }]);
    assert.equal(route.spec.tls.secretName, 'orchard-sandbox-previews-tls');
    const cert = out.find(
      (d) => d.kind === 'Certificate' && d.metadata?.name === 'orchard-sandbox-previews-tls'
    );
    assert.ok(cert, 'preview certificate rendered');
    assert.deepEqual(cert.spec.dnsNames, ['*.preview.example.com']);
    assert.deepEqual(cert.spec.issuerRef, {
      name: 'letsencrypt-dns01-wildcard',
      kind: 'ClusterIssuer'
    });
    const pattern = new RegExp(
      route.spec.routes[0].match.slice('HostRegexp(`'.length, -'`)'.length)
    );
    assert.match('5173-3f2d7e6a.preview.example.com', pattern);
    assert.doesNotMatch('5173-3f2d7e6a.previewxexample.com', pattern);
    assert.doesNotMatch('orchard.preview.example.com', pattern);
  }
);

test('preview tls honours an explicit issuer and secret', { skip: !helmAvailable() }, () => {
  const out = parsed(
    render([
      'sandbox.runners.previewDomain=preview.example.com',
      'sandbox.previews.tls.secretName=my-preview-tls',
      'sandbox.previews.tls.issuerRef.name=dns-issuer',
      'sandbox.previews.tls.issuerRef.kind=Issuer'
    ])
  );
  const route = out.find((d) => d.metadata?.name === 'orchard-sandbox-previews');
  assert.equal(route?.spec.tls.secretName, 'my-preview-tls');
  const cert = out.find((d) => d.kind === 'Certificate' && d.metadata?.name === 'my-preview-tls');
  assert.deepEqual(cert?.spec.issuerRef, { name: 'dns-issuer', kind: 'Issuer' });
});

test(
  'preview tls without an issuer expects a secret brought out of band',
  { skip: !helmAvailable() },
  () => {
    const out = parsed(
      render(['sandbox.runners.previewDomain=preview.example.com', 'certificates.enabled=false'])
    );
    assert.ok(out.some((d) => d.metadata?.name === 'orchard-sandbox-previews'));
    assert.ok(!out.some((d) => d.kind === 'Certificate' && /preview/.test(d.metadata?.name)));
  }
);

test('the preview route can be switched off', { skip: !helmAvailable() }, () => {
  const out = parsed(
    render(['sandbox.runners.previewDomain=preview.example.com', 'sandbox.previews.route=false'])
  );
  assert.ok(!out.some((d) => /sandbox-previews/.test(d.metadata?.name ?? '')));
});

function serverEnv(out: string): string {
  return docs(out).find((d) => /kind: Deployment/.test(d) && /name: server\n/.test(d)) ?? '';
}

test('sandboxes are not installed by default', { skip: !helmAvailable() }, () => {
  const out = render([]);
  assert.doesNotMatch(out, /SANDBOX_ENABLED/);
  assert.doesNotMatch(out, /PUBLIC_SANDBOX_ENABLED/);
  assert.doesNotMatch(out, /SANDBOX_NAMESPACE/);
  assert.ok(
    !parsed(out).some((d) => d.kind === 'Namespace' && d.metadata?.name === 'orchard-sandboxes')
  );
});

test(
  'sandbox.enabled installs the runner plumbing and no longer renders the retired switch',
  { skip: !helmAvailable() },
  () => {
    const out = render(['sandbox.enabled=true']);
    const server = serverEnv(out);
    assert.doesNotMatch(server, /SANDBOX_ENABLED/);
    assert.match(server, /SANDBOX_NAMESPACE, value: "orchard-sandboxes"/);
    assert.match(server, /ORCHARD_SERVER_NAMESPACE, value: "orchard"/);
    assert.doesNotMatch(out, /PUBLIC_SANDBOX_ENABLED/);
    const objects = parsed(out);
    assert.ok(
      objects.some((d) => d.kind === 'Namespace' && d.metadata?.name === 'orchard-sandboxes')
    );
    assert.ok(
      objects.some((d) => d.kind === 'Role' && d.metadata?.name === 'orchard-sandbox-manager')
    );
  }
);

test('sandbox.install renders the runner plumbing', { skip: !helmAvailable() }, () => {
  const out = render(['sandbox.install=true']);
  const server = serverEnv(out);
  assert.doesNotMatch(server, /SANDBOX_ENABLED/);
  assert.match(server, /SANDBOX_NAMESPACE, value: "orchard-sandboxes"/);
  assert.doesNotMatch(out, /PUBLIC_SANDBOX_ENABLED/);
  const objects = parsed(out);
  assert.ok(
    objects.some((d) => d.kind === 'NetworkPolicy' && d.metadata?.name === 'sandbox-isolation')
  );
  assert.ok(
    objects.some((d) => d.kind === 'RoleBinding' && d.metadata?.name === 'orchard-sandbox-manager')
  );
});

test('sandbox.install=false wins over sandbox.enabled', { skip: !helmAvailable() }, () => {
  const out = render(['sandbox.enabled=true', 'sandbox.install=false']);
  assert.doesNotMatch(out, /SANDBOX_NAMESPACE/);
  assert.ok(!parsed(out).some((d) => d.metadata?.name === 'sandbox-isolation'));
});

function renderValues(values: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'chart-values-'));
  try {
    const file = join(dir, 'values.json');
    writeFileSync(file, JSON.stringify(values));
    return execFileSync(
      'helm',
      ['template', 'orchard', chart, '--namespace', 'orchard', '-f', file],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test(
  'graft taps render as ORCHARD_GRAFT_TAPS and roll the pods',
  { skip: !helmAvailable() },
  () => {
    const tap = {
      name: 'acme',
      url: 'https://acme.dev/orchard',
      key: 'jH19I0aB5AuJcCBeYDFRWaFXHXJjx6kSNVg06m4PCb4='
    };
    const values = (url: string) => ({
      grafts: [{ id: 'notes', version: '1.2.0', digest: 'sha256:00', tap: 'acme' }],
      graftSettings: { trust: 'taps', taps: [{ ...tap, url }] }
    });
    const workloads = (out: string) =>
      parsed(out).filter((d) => d.kind === 'Deployment' && d.metadata?.name === 'server');
    const envOf = (out: string, name: string) =>
      workloads(out)[0].spec.template.spec.containers[0].env.find(
        (e: { name: string }) => e.name === name
      )?.value;
    const initEnv = (out: string, name: string) =>
      workloads(out)[0].spec.template.spec.initContainers[0].env.find(
        (e: { name: string }) => e.name === name
      )?.value;

    const out = renderValues(values(tap.url));
    assert.deepEqual(JSON.parse(envOf(out, 'ORCHARD_GRAFT_TAPS')), [tap]);
    assert.deepEqual(JSON.parse(initEnv(out, 'ORCHARD_GRAFT_TAPS')), [tap]);
    assert.equal(envOf(out, 'ORCHARD_GRAFT_TRUST'), 'taps');
    assert.deepEqual(JSON.parse(envOf(out, 'ORCHARD_GRAFTS'))[0].tap, 'acme');

    const hash = (o: string) =>
      workloads(o)[0].spec.template.metadata.annotations['orchard.my/grafts'];
    assert.notEqual(hash(out), hash(renderValues(values('https://mirror.acme.dev/orchard'))));

    const plain = renderValues({
      grafts: [{ id: 'notes', version: '1.2.0', digest: 'sha256:00' }]
    });
    assert.equal(envOf(plain, 'ORCHARD_GRAFT_TRUST'), 'listed');
    assert.equal(envOf(plain, 'ORCHARD_GRAFT_TAPS'), undefined);
  }
);

test('the metrics stack runs on pinned images from values', { skip: !helmAvailable() }, () => {
  const imageOf = (out: string, name: string) =>
    parsed(out).find(
      (d) =>
        ['Deployment', 'StatefulSet', 'DaemonSet'].includes(d.kind) && d.metadata?.name === name
    )?.spec.template.spec.containers[0].image;
  const out = render([]);
  for (const name of ['victoriametrics', 'vmagent', 'kube-state-metrics', 'node-exporter']) {
    assert.match(imageOf(out, name), /:v\d+\.\d+\.\d+$/, `${name} is pinned to a release`);
  }
  assert.equal(
    imageOf(out, 'vmagent').split(':')[1],
    imageOf(out, 'victoriametrics').split(':')[1],
    'vmagent matches victoriametrics'
  );
  const custom = render([
    'metrics.vmagent.image=mirror.local/vmagent:v1',
    'metrics.kubeStateMetrics.image=mirror.local/ksm:v2',
    'metrics.nodeExporter.image=mirror.local/node-exporter:v3'
  ]);
  assert.equal(imageOf(custom, 'vmagent'), 'mirror.local/vmagent:v1');
  assert.equal(imageOf(custom, 'kube-state-metrics'), 'mirror.local/ksm:v2');
  assert.equal(imageOf(custom, 'node-exporter'), 'mirror.local/node-exporter:v3');
});

test('the pooler pins pgbouncer unless the image is cleared', { skip: !helmAvailable() }, () => {
  const pgbouncer = (out: string) =>
    parsed(out)
      .find((d) => d.kind === 'Pooler')
      ?.spec.template.spec.containers.find((c: { name: string }) => c.name === 'pgbouncer');
  const pinned = pgbouncer(render(['postgres.pooler.enabled=true']));
  assert.match(pinned.image, /^ghcr\.io\/cloudnative-pg\/pgbouncer:\d+\.\d+\.\d+$/);
  const operatorDefault = pgbouncer(
    render(['postgres.pooler.enabled=true', 'postgres.pooler.image='])
  );
  assert.equal(operatorDefault.image, undefined);
  assert.ok(operatorDefault.resources, 'resources still render');
});

test(
  'orchard-db archives to object storage and takes a first backup at once when backups are on',
  { skip: !helmAvailable() },
  () => {
    const off = docs(render([]));
    assert.equal(
      off.some((d) => d.includes('kind: ScheduledBackup')),
      false
    );
    const offCluster = off.find(
      (d) => d.includes('kind: Cluster\n') && d.includes('name: orchard-db\n')
    );
    assert.match(offCluster ?? '', /max_slot_wal_keep_size: "2GB"/);
    assert.ok(!(offCluster ?? '').includes('barmanObjectStore'));

    const on = docs(
      render([
        'postgres.backup.enabled=true',
        'postgres.backup.destinationPath=s3://bucket/orchard',
        'postgres.backup.endpointURL=https://acct.r2.cloudflarestorage.com'
      ])
    );
    const cluster = on.find(
      (d) => d.includes('kind: Cluster\n') && d.includes('name: orchard-db\n')
    );
    assert.match(cluster ?? '', /destinationPath: "s3:\/\/bucket\/orchard"/);
    assert.match(cluster ?? '', /name: orchard-db-backup\s+key: ACCESS_KEY_ID/);
    const schedule = on.find((d) => d.includes('kind: ScheduledBackup'));
    assert.match(schedule ?? '', /immediate: true/);
    assert.match(schedule ?? '', /cluster:\s+name: orchard-db/);

    assert.throws(() => render(['postgres.backup.enabled=true']), /destinationPath is required/);
  }
);

test(
  'orchard-db can archive through the barman cloud plugin instead of in-tree barman',
  { skip: !helmAvailable() },
  () => {
    const out = docs(
      render([
        'postgres.backup.enabled=true',
        'postgres.backup.method=plugin',
        'postgres.backup.destinationPath=s3://bucket/orchard'
      ])
    );
    const cluster = out.find(
      (d) => d.includes('kind: Cluster\n') && d.includes('name: orchard-db\n')
    );
    assert.match(cluster ?? '', /barmanObjectName: orchard-db-store/);
    assert.ok(!(cluster ?? '').includes('barmanObjectStore'));
    assert.match(
      out.find((d) => d.includes('kind: ObjectStore')) ?? '',
      /limits: \{ memory: 512Mi \}/
    );
    assert.match(out.find((d) => d.includes('kind: ScheduledBackup')) ?? '', /method: plugin/);
  }
);

test(
  'databases outside CNPG get a nightly pg_dump uploaded to object storage',
  { skip: !helmAvailable() },
  () => {
    assert.equal(
      docs(render([])).some((d) => d.includes('kind: CronJob') && d.includes('dump-')),
      false
    );
    const out = docs(
      render([
        'databaseDumps.enabled=true',
        'databaseDumps.destination.bucket=backups',
        'databaseDumps.destination.endpointURL=https://acct.r2.cloudflarestorage.com',
        'databaseDumps.targets[0].name=harbor',
        'databaseDumps.targets[0].namespace=harbor',
        'databaseDumps.targets[0].host=harbor-database',
        'databaseDumps.targets[0].database=registry',
        'databaseDumps.targets[0].user=postgres',
        'databaseDumps.targets[0].passwordSecret.name=harbor-database',
        'databaseDumps.targets[0].passwordSecret.key=POSTGRES_PASSWORD'
      ])
    );
    const job = out.find((d) => d.includes('name: dump-harbor'));
    assert.ok(job, 'cronjob rendered');
    assert.match(job, /namespace: harbor/);
    assert.match(job, /pg_dump --format=custom/);
    assert.match(job, /s3:\/\/backups\/platform-dumps\/harbor\//);
    assert.match(job, /--endpoint-url "https:\/\/acct\.r2\.cloudflarestorage\.com"/);
  }
);
