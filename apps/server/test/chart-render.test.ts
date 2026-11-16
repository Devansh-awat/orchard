import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadAll } from 'js-yaml';
import {
  KubernetesSandboxRunner,
  SANDBOX_INGRESS_PORTS
} from '../../../grafts/greenhouse/server/src/sandboxes/runners/kubernetes.runner';
import { PREVIEW_PORTS } from '../../../grafts/greenhouse/server/src/sandboxes/preview/preview-auth';
import { cniCheck, type DoctorInputs } from '../src/doctor/doctor.checks';
import { toolAvailable } from './support/tools';

const chart = resolve(__dirname, '../../../infra/charts/orchard');

function helmAvailable(): boolean {
  return toolAvailable('helm', ['version', '--short']);
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
    const out = render([
      'r2Proxy.enabled=true',
      'r2Proxy.upstream.endpoint=https://r2.example.test',
      'r2Proxy.defaultBucket=platform-backups',
      'r2Proxy.databasePassword=pw-for-test'
    ]);
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
    'r2Proxy.upstream.endpoint=https://r2.example.test',
    'r2Proxy.defaultBucket=platform-backups',
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
  assert.doesNotMatch(out, /\[registry\."\d+\.\d+/, 'no hardcoded registry ip');
  assert.match(out, /\[registry\."harbor-core\.harbor\.svc\.cluster\.local"\]\s+http = true/);
  assert.match(out, /\[registry\."zot\.orchard\.svc\.cluster\.local:5000"\]\s+http = true/);
});

test("a stock render names nobody else's domain or registry", { skip: !helmAvailable() }, () => {
  const out = render([]);
  assert.match(out, /"auths": \{\s*\}/, 'no registry credentials');
  assert.ok(!out.includes('longhorn'), 'no storage class from another cluster');
  assert.ok(!out.includes('https-wildcard'), 'no wildcard listener without an app domain');
  assert.ok(!out.includes('kind: Certificate'), 'no wildcard Certificate without an app domain');
});

test(
  'an app domain renders the wildcard Certificate and no Gateway',
  { skip: !helmAvailable() },
  () => {
    const out = render(['gateway.http.appDomain=apps.example.com']);
    assert.match(out, /commonName: "\*\.apps\.example\.com"/);
    assert.doesNotMatch(out, /gateway\.networking\.k8s\.io/, 'Gateway API is off by default');
  }
);

test(
  'a gateway turned on renders the wildcard listener with the chart labels',
  { skip: !helmAvailable() },
  () => {
    const out = render(['gateway.enabled=true', 'gateway.http.appDomain=apps.example.com']);
    assert.match(out, /hostname: "\*\.apps\.example\.com"/);
    assert.match(out, /kind: Gateway\nmetadata:\n  name: db-gateway/);
    assert.match(out, /app\.kubernetes\.io\/part-of: orchard/);
    assert.doesNotMatch(out, /leaf\.dev/);
  }
);

test('listing a registry without credentials refuses to render', { skip: !helmAvailable() }, () => {
  assert.throws(
    () => render(['builders.harbor.hosts[0]=registry.example.com']),
    /builders\.harbor\.username and builders\.harbor\.password are required/
  );
  const out = render([
    'builders.harbor.hosts[0]=registry.example.com',
    'builders.harbor.username=robot',
    'builders.harbor.password=secret'
  ]);
  assert.match(out, /"registry\.example\.com": \{ "username": "robot"/);
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
    assert.match(
      imageOf(out, name),
      /:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/,
      `${name} is pinned to a release digest`
    );
  }
  const tagOf = (image: string) => image.split('@')[0].split(':')[1];
  assert.equal(
    tagOf(imageOf(out, 'vmagent')),
    tagOf(imageOf(out, 'victoriametrics')),
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
  assert.match(
    pinned.image,
    /^ghcr\.io\/cloudnative-pg\/pgbouncer:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/
  );
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
  'the local bucket job names its region, and the job name follows the script',
  { skip: !helmAvailable() },
  () => {
    const local = ['objectStorage.local.enabled=true', 'r2Proxy.enabled=true'];
    const job = docs(render(local)).find((d) => d.includes('name: object-storage-bucket-'));
    assert.ok(job, 'bucket job rendered');
    assert.match(
      job,
      /--create-bucket-configuration \\"LocationConstraint=\$AWS_DEFAULT_REGION\\"/
    );
    assert.match(job, /name: AWS_DEFAULT_REGION, value: "auto"/);
    const name = (out: string) => out.match(/name: (object-storage-bucket-\w+)/)?.[1];
    assert.notEqual(
      name(render(local)),
      name(render([...local, 'objectStorage.local.region=eu-west-1']))
    );
    assert.equal(
      docs(render([])).some((d) => d.includes('object-storage-bucket-')),
      false
    );
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

test(
  'the local store reaches the server under fallback names, so storage stays editable',
  { skip: !helmAvailable() },
  () => {
    const out = render(['objectStorage.local.enabled=true', 'r2Proxy.enabled=true']);
    const server = docs(out).find(
      (d) => d.includes('kind: Deployment') && d.includes('name: server')
    );
    assert.ok(server, 'server deployment rendered');
    assert.match(server, /name: LOCAL_STORE_BACKUP_BUCKET, value: "orchard-backups"/);
    assert.match(server, /name: LOCAL_STORE_UPLOADS_BUCKET, value: "orchard-uploads"/);
    assert.match(server, /name: LOCAL_STORE_ACCESS_KEY_ID/);
    for (const name of [
      'R2_ENDPOINT',
      'R2_BACKUP_BUCKET',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY'
    ]) {
      assert.equal(server.includes(`name: ${name}`), false, `${name} must not be set`);
    }
    assert.doesNotMatch(server, /BACKUP_PROXY_CHART_UPSTREAM/);
    const job = docs(out).find((d) => d.includes('name: object-storage-bucket-'));
    assert.match(job!, /name: BUCKETS, value: "orchard-backups orchard-uploads"/);
    const secret = docs(out).find(
      (d) => d.includes('name: orchard-object-storage') && d.includes('kind: Secret')
    );
    assert.match(secret!, /ACCESS_KEY_ID:/);
    assert.match(secret!, /ACCESS_SECRET_KEY:/);
  }
);

test('real R2 env beside the local store is left to win', { skip: !helmAvailable() }, () => {
  const out = render([
    'objectStorage.local.enabled=true',
    'r2Proxy.enabled=true',
    'server.env[0].name=R2_BACKUP_BUCKET',
    'server.env[0].value=mine'
  ]);
  const server = docs(out).find(
    (d) => d.includes('kind: Deployment') && d.includes('name: server')
  );
  assert.match(server!, /R2_BACKUP_BUCKET/);
  assert.match(server!, /LOCAL_STORE_BACKUP_BUCKET/);
});

test(
  'the backup proxy runs whenever it can, so tenants never need the root key',
  { skip: !helmAvailable() },
  () => {
    const out = render([]);
    const proxy = docs(out).find(
      (d) => d.includes('kind: Deployment') && d.includes('name: r2-proxy')
    );
    assert.ok(proxy, 'proxy runs with no upstream configured');
    assert.match(proxy, /secretName: r2-proxy-stored/);
    assert.match(proxy, /optional: true/);
    const upstream = docs(out).find(
      (d) => d.includes('name: r2-proxy-upstream') && d.includes('kind: Secret')
    );
    assert.equal(upstream!.includes('R2_ENDPOINT'), false);
    const server = docs(out).find(
      (d) => d.includes('kind: Deployment') && d.includes('name: server')
    );
    assert.match(server!, /name: BACKUP_PROXY_ENABLED, value: "true"/);
    assert.doesNotMatch(server!, /BACKUP_PROXY_CHART_UPSTREAM/);
    const role = docs(out).find((d) => d.includes('kind: Role') && d.includes('r2-proxy-stored'));
    assert.match(role!, /resourceNames: \["r2-proxy-stored"\]/);
    assert.equal(
      docs(render(['r2Proxy.enabled=false'])).some((d) => d.includes('name: r2-proxy-upstream')),
      false
    );
  }
);

test(
  'an upstream set in values is what the proxy uses, and the server knows it',
  { skip: !helmAvailable() },
  () => {
    const out = render([
      'r2Proxy.upstream.endpoint=https://s3.eu-west-1.amazonaws.com',
      'r2Proxy.upstream.region=eu-west-1',
      'r2Proxy.upstream.pathStyle=false',
      'r2Proxy.defaultBucket=platform-backups',
      'r2Proxy.databasePassword=pw-for-test'
    ]);
    const upstream = docs(out).find(
      (d) => d.includes('name: r2-proxy-upstream') && d.includes('kind: Secret')
    );
    assert.match(upstream!, /R2_ENDPOINT: "https:\/\/s3\.eu-west-1\.amazonaws\.com"/);
    assert.match(upstream!, /R2_REGION: "eu-west-1"/);
    assert.match(upstream!, /R2_PATH_STYLE: "false"/);
    const server = docs(out).find(
      (d) => d.includes('kind: Deployment') && d.includes('name: server')
    );
    assert.match(server!, /name: BACKUP_PROXY_CHART_UPSTREAM, value: "true"/);
    assert.equal(
      docs(
        render([
          'r2Proxy.upstream.endpoint=https://x.example.com',
          'r2Proxy.defaultBucket=platform-backups',
          'r2Proxy.databasePassword=p'
        ])
      )
        .find((d) => d.includes('name: r2-proxy-upstream') && d.includes('kind: Secret'))!
        .includes('R2_PATH_STYLE'),
      false
    );
  }
);

test(
  'an upstream endpoint without a bucket allowlist does not render',
  { skip: !helmAvailable() },
  () => {
    const base = ['r2Proxy.upstream.endpoint=https://x.example.com', 'r2Proxy.databasePassword=p'];
    assert.throws(() => render(base), /r2Proxy\.defaultBucket or r2Proxy\.allowedBuckets/);
    const listed = render([...base, 'r2Proxy.allowedBuckets={platform-backups,archive}']);
    const upstream = docs(listed).find(
      (d) => d.includes('name: r2-proxy-upstream') && d.includes('kind: Secret')
    );
    assert.match(upstream!, /ALLOWED_BUCKETS: "platform-backups,archive"/);
  }
);

test('database dumps prune old copies only when asked', { skip: !helmAvailable() }, () => {
  const sets = [
    'databaseDumps.enabled=true',
    'databaseDumps.destination.bucket=b',
    'databaseDumps.targets[0].name=orchard',
    'databaseDumps.targets[0].host=h',
    'databaseDumps.targets[0].database=d',
    'databaseDumps.targets[0].user=u',
    'databaseDumps.targets[0].passwordSecret.name=s'
  ];
  const plain = docs(render(sets)).find((d) => d.includes('name: dump-orchard'));
  assert.equal(plain!.includes('aws s3 rm'), false);
  const kept = docs(render([...sets, 'databaseDumps.destination.keep=7'])).find((d) =>
    d.includes('name: dump-orchard')
  );
  assert.match(kept!, /tail -n \+8/);
  assert.match(kept!, /aws s3 rm/);
});

test(
  'ingress metrics jobs are pinned to the ingress controller namespace and labels',
  { skip: !helmAvailable() },
  () => {
    const out = render([]);
    const traefik = out.slice(out.indexOf('job_name: traefik'));
    assert.match(traefik, /namespaces: \{ names: \["traefik"\] \}/);
    assert.match(traefik, /label: "app\.kubernetes\.io\/name=traefik"/);
    assert.match(out, /INGRESS_METRICS_TRAEFIK_NAMESPACE, value: "traefik"/);
    assert.match(out, /INGRESS_METRICS_HAPROXY_NAMESPACE, value: "network"/);

    const custom = render([
      'metrics.ingress.traefik.namespaces={kube-system}',
      'metrics.ingress.traefik.labels.app\\.kubernetes\\.io/name=traefik-ingress'
    ]);
    assert.match(custom, /namespaces: \{ names: \["kube-system"\] \}/);
    assert.match(custom, /INGRESS_METRICS_TRAEFIK_NAMESPACE, value: "kube-system"/);
    const pods = custom.slice(custom.indexOf('job_name: kubernetes-pods'));
    assert.match(pods, /regex: "kube-system\|network"\s+action: drop/);
    assert.match(pods, /\(traefik\|haproxy\|cnpg\|kube\|container\|kubelet\|node\|vm\|go_gc\)_/);
  }
);

test('the dashboard source link is set at runtime', { skip: !helmAvailable() }, () => {
  assert.doesNotMatch(render([]), /PUBLIC_SOURCE_URL/);
  const out = render(['frontend.sourceUrl=https://git.example.com/me/orchard']);
  assert.match(out, /PUBLIC_SOURCE_URL, value: "https:\/\/git\.example\.com\/me\/orchard"/);
});

test('per-database public db certificates are opt-in', { skip: !helmAvailable() }, () => {
  assert.doesNotMatch(render([]), /PUBLIC_DB_TLS_MODE/);
  const out = render(['publicTls.db.mode=perDatabase']);
  assert.match(out, /PUBLIC_DB_TLS_MODE, value: "per-database"/);
  assert.match(out, /PUBLIC_DB_TLS_ISSUER_NAME/);
  assert.match(out, /resources: \["certificates"\]\s+verbs: \["get", "list", "watch", "create"/);
});

test(
  'the database sandbox MutatingAdmissionPolicy renders only when databases.runtimeClassName is set',
  { skip: !helmAvailable() },
  () => {
    assert.ok(!render([]).includes('orchard-database-runtime-class'));
    const out = render(['databases.runtimeClassName=gvisor']);
    assert.match(out, /kind: MutatingAdmissionPolicy\n/);
    assert.match(out, /runtimeClassName: "gvisor"/);
    assert.match(out, /'cnpg\.io\/cluster' in object\.metadata\.labels/);
  }
);

test(
  'the tenant admission guard denies by default and keeps hardening advisory',
  { skip: !helmAvailable() },
  () => {
    const out = render([]);
    const bindings = docs(out).filter((d) => d.includes('kind: ValidatingAdmissionPolicyBinding'));
    assert.ok(bindings.length >= 17, `bindings rendered: ${bindings.length}`);
    const hardening = bindings.filter((b) => b.includes('orchard-tenant-pods-hardening'));
    assert.ok(hardening.length >= 1);
    for (const b of hardening) assert.match(b, /validationActions: \["Warn","Audit"\]/);
    for (const b of bindings.filter((b) => !hardening.includes(b)))
      assert.match(b, /validationActions: \["Deny"\]/);
    assert.ok(bindings.some((b) => b.includes('key: orchard.dev/managed')));
    assert.ok(
      bindings.every((b) => !b.includes('paramRef') || b.includes('parameterNotFoundAction: Allow'))
    );
    const warn = render(['admissionPolicies.validationActions={Warn,Audit}']);
    assert.match(warn, /name: orchard-tenant-pods\n[\s\S]*?validationActions: \["Warn","Audit"\]/);
    assert.ok(!render(['admissionPolicies.enabled=false']).includes('orchard-tenant-policy'));
  }
);

function podSpecs(objects: any[]): { name: string; spec: any }[] {
  const out: { name: string; spec: any }[] = [];
  for (const d of objects) {
    const name = `${d.kind}/${d.metadata?.name}`;
    if (d.kind === 'Cluster') out.push({ name, spec: d.spec });
    else if (d.kind === 'Pooler') out.push({ name, spec: d.spec?.template?.spec });
    else if (d.spec?.template?.spec?.containers) out.push({ name, spec: d.spec.template.spec });
  }
  return out;
}

test(
  'platform pods run under the orchard-platform priority class',
  { skip: !helmAvailable() },
  () => {
    const objects = parsed(render(['postgres.enabled=true', 'redis.enabled=true']));
    const klass = objects.find((d) => d.kind === 'PriorityClass');
    assert.equal(klass.metadata.name, 'orchard-platform');
    assert.equal(klass.value, 100000);
    assert.equal(klass.globalDefault, false);
    const pods = podSpecs(objects);
    assert.ok(pods.length >= 8, `found ${pods.length} platform pod specs`);
    for (const name of ['Deployment/server', 'Deployment/frontend', 'Deployment/redis']) {
      assert.equal(pods.find((p) => p.name === name)?.spec.priorityClassName, 'orchard-platform');
    }
    const unclassed = pods
      .filter((p) => p.spec.priorityClassName !== 'orchard-platform')
      .map((p) => p.name);
    assert.deepEqual(
      unclassed,
      ['StatefulSet/fc-builder'].filter((n) => unclassed.includes(n))
    );
  }
);

test(
  'priorityClasses.enabled=false renders no class and no references',
  { skip: !helmAvailable() },
  () => {
    const out = render(['priorityClasses.enabled=false', 'postgres.enabled=true']);
    assert.ok(!parsed(out).some((d) => d.kind === 'PriorityClass'));
    assert.doesNotMatch(out, /priorityClassName: orchard-platform/);
  }
);

test('the tenant pod policy refuses system and platform priority classes', () => {
  const policies = readFileSync(resolve(chart, 'policies/orchard-tenant-policies.yaml'), 'utf8');
  assert.match(policies, /priorityClassName\.startsWith\('system-'\)/);
  assert.match(policies, /priorityClassName\.startsWith\('orchard-'\)/);
});

function vectorConfig(out: string): any {
  const map = parsed(out).find((d) => d.kind === 'ConfigMap' && d.data?.['vector.yaml']);
  assert.ok(map, 'vector ConfigMap rendered');
  return loadAll(map.data['vector.yaml'])[0];
}

test(
  'tenant logs are throttled per namespace before the shared store',
  { skip: !helmAvailable() },
  () => {
    const config = vectorConfig(render([]));
    const throttle = config.transforms.tenant_throttle;
    assert.equal(throttle.type, 'throttle');
    assert.deepEqual(throttle.inputs, ['tenant_shape']);
    assert.equal(throttle.threshold, 2000);
    assert.equal(throttle.window_secs, 1);
    assert.equal(throttle.key_field, '{{ namespace }}');
    assert.deepEqual(config.sinks.victorialogs.inputs, ['tenant_throttle', 'ingress_shape']);
  }
);

test('the log throttle rate is a chart value and 0 removes it', { skip: !helmAvailable() }, () => {
  const tuned = vectorConfig(render(['logs.vector.throttle.eventsPerSecond=500']));
  assert.equal(tuned.transforms.tenant_throttle.threshold, 500);
  const off = vectorConfig(render(['logs.vector.throttle.eventsPerSecond=0']));
  assert.equal(off.transforms.tenant_throttle, undefined);
  assert.deepEqual(off.sinks.victorialogs.inputs, ['tenant_shape', 'ingress_shape']);
});

test('the flannel policy enforcer renders only when enabled', { skip: !helmAvailable() }, () => {
  assert.ok(!parsed(render([])).some((d) => d.metadata?.name === 'kube-router'));
  const out = parsed(render(['networkPolicy.enforcer.enabled=true']));
  const ns = out.find((d) => d.kind === 'Namespace' && d.metadata.name === 'orchard-netpol');
  assert.equal(ns?.metadata.labels['pod-security.kubernetes.io/enforce'], 'privileged');
  const ds = out.find((d) => d.kind === 'DaemonSet' && d.metadata.name === 'kube-router');
  assert.equal(ds?.metadata.namespace, 'orchard-netpol');
  const pod = ds.spec.template.spec;
  assert.equal(pod.hostNetwork, true);
  assert.equal(pod.priorityClassName, 'system-node-critical');
  assert.equal(pod.serviceAccountName, 'kube-router');
  assert.match(
    pod.containers[0].image,
    /^cloudnativelabs\/kube-router:v[\d.]+@sha256:[0-9a-f]{64}$/
  );
  for (const flag of [
    '--run-firewall=true',
    '--run-router=false',
    '--run-service-proxy=false',
    '--enable-cni=false'
  ]) {
    assert.ok(pod.containers[0].args.includes(flag), flag);
  }
  const role = out.find(
    (d) => d.kind === 'ClusterRole' && d.metadata.name === 'orchard-kube-router'
  );
  for (const rule of role.rules) assert.deepEqual(rule.verbs, ['get', 'list', 'watch']);
  const binding = out.find(
    (d) => d.kind === 'ClusterRoleBinding' && d.metadata.name === 'orchard-kube-router'
  );
  assert.deepEqual(binding.subjects, [
    { kind: 'ServiceAccount', name: 'kube-router', namespace: 'orchard-netpol' }
  ]);
  const doctor = cniCheck({
    apiGroups: { ok: true, value: [] },
    nodes: { ok: true, value: [{ name: 'n1', kubelet: 'v1.34.1' }] },
    daemonSets: {
      ok: true,
      value: [
        { name: 'kube-flannel', namespace: 'kube-system', desired: 1, ready: 1 },
        { name: ds.metadata.name, namespace: ds.metadata.namespace, desired: 1, ready: 1 }
      ]
    }
  } as DoctorInputs);
  assert.equal(doctor.status, 'pass');
});

test('the policy enforcer can live in kube-system', { skip: !helmAvailable() }, () => {
  const out = parsed(
    render(['networkPolicy.enforcer.enabled=true', 'networkPolicy.enforcer.namespace=kube-system'])
  );
  assert.ok(!out.some((d) => d.kind === 'Namespace' && d.metadata.name === 'kube-system'));
  const ds = out.find((d) => d.kind === 'DaemonSet' && d.metadata.name === 'kube-router');
  assert.equal(ds?.metadata.namespace, 'kube-system');
});
