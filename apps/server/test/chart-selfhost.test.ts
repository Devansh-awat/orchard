import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadAll } from 'js-yaml';
import { recoveryClusterSpec } from '../src/kubernetes/cnpg-recovery';
import { toolAvailable } from './support/tools';

const chart = resolve(__dirname, '../../../infra/charts/orchard');

function helmAvailable(): boolean {
  return toolAvailable('helm', ['version', '--short']);
}

const skip = !helmAvailable();

function render(sets: string[], valuesFile?: string): string {
  const args = ['template', 'orchard', chart, '--namespace', 'orchard'];
  if (valuesFile) args.push('-f', valuesFile);
  for (const s of sets) args.push('--set', s);
  return execFileSync('helm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const minimal = join(chart, 'examples/minimal-values.yaml');
const repo = resolve(chart, '../../..');

function parsed(yaml: string): any[] {
  return loadAll(yaml).filter(Boolean) as any[];
}

function namespaces(yaml: string): any[] {
  return parsed(yaml).filter((d) => d.kind === 'Namespace');
}

test(
  'the documented minimal values render nothing that belongs to another cluster',
  { skip },
  () => {
    const out = render([], minimal);
    assert.doesNotMatch(out, /db\.orchard\.my/);
    assert.doesNotMatch(out, /longhorn/);
    for (const doc of parsed(out)) {
      for (const container of doc.spec?.template?.spec?.containers ?? []) {
        const names = (container.env ?? []).map((e: { name: string }) => e.name);
        assert.equal(
          new Set(names).size,
          names.length,
          `${doc.metadata.name}/${container.name} has a duplicate env name`
        );
      }
    }
  }
);

function serverEnv(yaml: string, name: string): string[] {
  const server = parsed(yaml).find((d) => d.kind === 'Deployment' && d.metadata.name === 'server');
  return server.spec.template.spec.containers[0].env
    .filter((e: { name: string }) => e.name === name)
    .map((e: { value: string }) => e.value);
}

test('the cnpg operator namespace reaches the server only when it is set', { skip }, () => {
  assert.deepEqual(serverEnv(render([]), 'CNPG_OPERATOR_NAMESPACE'), []);
  assert.deepEqual(
    serverEnv(render(['tenant.cnpgOperatorNamespace=cnpg-system']), 'CNPG_OPERATOR_NAMESPACE'),
    ['cnpg-system']
  );
  assert.deepEqual(serverEnv(render([], minimal), 'CNPG_OPERATOR_NAMESPACE'), ['cnpg-system']);
});

test('a value in server.env wins over the cnpg operator namespace', { skip }, () => {
  const out = render([
    'tenant.cnpgOperatorNamespace=cnpg-system',
    'server.env[0].name=CNPG_OPERATOR_NAMESPACE',
    'server.env[0].value=elsewhere'
  ]);
  assert.deepEqual(serverEnv(out, 'CNPG_OPERATOR_NAMESPACE'), ['elsewhere']);
});

test('every install guide carries the same minimal values', () => {
  const example = readFileSync(minimal, 'utf8');
  for (const doc of [
    'apps/docs/src/content/docs/start/install.md',
    'infra/charts/orchard/README.md'
  ]) {
    const text = readFileSync(join(repo, doc), 'utf8');
    const inNumberedStep = text.replace(/^ {3}/gm, '');
    assert.ok(text.includes(example) || inNumberedStep.includes(example), doc);
  }
});

test('the chart creates a missing network namespace and keeps it', { skip }, () => {
  const network = namespaces(render([])).find((d) => d.metadata.name === 'network');
  assert.ok(network);
  assert.equal(network.metadata.annotations['helm.sh/resource-policy'], 'keep');
  const release = namespaces(render([])).find((d) => d.metadata.name === 'orchard');
  assert.equal(release.metadata.annotations, undefined);
});

test(
  'createNamespace=false renders neither namespace, as production and the installer set',
  { skip },
  () => {
    const names = namespaces(render(['createNamespace=false'])).map((d) => d.metadata.name);
    assert.ok(!names.includes('network'));
    assert.ok(!names.includes('orchard'));
  }
);

test('no database wildcard Certificate without a domain', { skip }, () => {
  const certificate = (yaml: string) =>
    parsed(yaml).find((d) => d.kind === 'Certificate' && /db/.test(d.metadata.name));
  assert.equal(certificate(render([])), undefined);
  const set = certificate(render(['certificates.wildcards.db.domain=db.example.com']));
  assert.deepEqual(set.spec.dnsNames, ['*.db.example.com', 'db.example.com']);
});

test('an unset storage class is left to the cluster', () => {
  const spec = recoveryClusterSpec({
    instances: 1,
    imageName: 'postgres:17',
    storageSize: '1Gi',
    storageClass: process.env.UNSET_STORAGE_CLASS || undefined,
    parameters: {},
    bootstrap: {},
    externalClusters: []
  });
  assert.deepEqual(JSON.parse(JSON.stringify(spec)).storage, { size: '1Gi' });
  for (const file of [
    'kubernetes/k8s-cnpg.service.ts',
    'kubernetes/kubernetes.service.ts',
    'projects/database-operations.service.ts'
  ]) {
    assert.doesNotMatch(
      readFileSync(join(repo, 'apps/server/src', file), 'utf8'),
      /K8S_STORAGE_CLASS \|\| 'longhorn'/
    );
  }
});

function deployment(out: string, name: string): string {
  return (
    out
      .split(/^---$/m)
      .find((d) => /kind: Deployment/.test(d) && new RegExp(`name: ${name}\\n`).test(d)) ?? ''
  );
}

test('status and vanity hosts route to the frontend in the release namespace', { skip }, () => {
  const env = deployment(render(['namespace=paas', 'frontend.service.port=3100']), 'server');
  assert.match(env, /name: PLATFORM_NAMESPACE, value: "paas"/);
  assert.match(env, /name: PLATFORM_SERVICE_NAME, value: "frontend"/);
  assert.match(env, /name: PLATFORM_SERVICE_PORT, value: "3100"/);
});

test('an operator supplying env from a Secret keeps its platform target', { skip }, () => {
  const out = render([
    'server.envFrom[0].secretRef.name=orchard-server-env',
    'server.env[0].name=BASE_DOMAIN',
    'server.env[0].value=orchard.my'
  ]);
  assert.doesNotMatch(deployment(out, 'server'), /PLATFORM_(NAMESPACE|SERVICE_NAME|SERVICE_PORT)/);
  assert.doesNotMatch(deployment(out, 'frontend'), /PUBLIC_BASE_DOMAIN|PUBLIC_PLATFORM_ORIGIN/);
});

test('a platform target set in server.env is not rendered twice', { skip }, () => {
  const env = deployment(
    render(['server.env[0].name=PLATFORM_NAMESPACE', 'server.env[0].value=elsewhere']),
    'server'
  );
  assert.equal((env.match(/PLATFORM_NAMESPACE/g) ?? []).length, 1);
  assert.match(env, /value: elsewhere/);
});

test('the frontend learns the vanity domain and where the api really is', { skip }, () => {
  assert.doesNotMatch(
    deployment(render([]), 'frontend'),
    /PUBLIC_BASE_DOMAIN|PUBLIC_PLATFORM_ORIGIN/
  );
  const env = deployment(
    render([
      'server.env[0].name=BASE_DOMAIN',
      'server.env[0].value=apps.example.com',
      'server.env[1].name=FRONTEND_URL',
      'server.env[1].value=https://orchard.example.com'
    ]),
    'frontend'
  );
  assert.match(env, /name: PUBLIC_BASE_DOMAIN, value: "apps.example.com"/);
  assert.match(env, /name: PUBLIC_PLATFORM_ORIGIN, value: "https:\/\/orchard.example.com"/);
});

test('node exporter serves its metrics to vmagent with credentials', { skip }, () => {
  const docs = parsed(render(['metrics.enabled=true'], minimal));
  const secret = docs.find((d) => d.kind === 'Secret' && d.metadata.name === 'node-exporter-auth');
  assert.ok(secret, 'the credentials secret renders');
  const password = Buffer.from(secret.data.password, 'base64').toString();
  const web = Buffer.from(secret.data['web.yml'], 'base64').toString();
  assert.match(web, /^basic_auth_users:\n  vmagent: \$2[aby]\$/);
  assert.ok(!web.includes(password), 'the web config holds only a hash');

  const exporter = docs.find((d) => d.kind === 'DaemonSet' && d.metadata.name === 'node-exporter');
  assert.ok(
    exporter.spec.template.spec.containers[0].args.includes(
      '--web.config.file=/etc/node-exporter/web.yml'
    )
  );

  const agent = docs.find((d) => d.kind === 'Deployment' && d.metadata.name === 'vmagent');
  const mounts = agent.spec.template.spec.containers[0].volumeMounts.map((m: any) => m.mountPath);
  assert.ok(mounts.includes('/etc/node-exporter-auth'));
  const config = docs.find((d) => d.kind === 'ConfigMap' && d.metadata.name === 'vmagent-config');
  assert.match(
    Object.values(config.data).join('\n') as string,
    /job_name: node-exporter\n\s+basic_auth:\n\s+username: vmagent\n\s+password_file: \/etc\/node-exporter-auth\/password/
  );
});
