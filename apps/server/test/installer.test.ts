import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const installer = resolve(__dirname, '../../../install/install.sh');
const chart = resolve(__dirname, '../../../infra/charts/orchard');

function has(tool: string, flag: string): boolean {
  try {
    execFileSync(tool, [flag], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const preamble = `
export ORCHARD_LIB_ONLY=1 NO_COLOR=1 ORCHARD_NO_PACING=1
source "${installer}"
set +e
step() { :; }
HTTP_SUFFIX= HTTPS_SUFFIX= USE_TLS=true INGRESS_MODE=public CERT_ISSUER=letsencrypt
HTTP_PORT=80 HTTPS_PORT=443 IMAGE_TAG=latest IMAGE_PULL_POLICY=Always
ORCHARD_APP_DOMAIN=apps.example.com ORCHARD_DOMAIN=orchard.example.com
ORCHARD_MCP_DOMAIN=mcp.example.com MAX_BUILDS=2 DB_DEFAULT_MEMORY_MB=1024 ARCH=amd64
REGISTRY_HOST=registry.local REGISTRY_PORT=5000 REGISTRY_USER=orchard REGISTRY_PASSWORD=sekret
BUILD_CACHE_GB=5 LOGS_SIZE_GB=5 LOGS_MAX_DISK_GB=4 OBJECT_STORAGE_GB=5 SMALL_BOX=false
ORCHARD_METRICS=true ORCHARD_LOGS=true ORCHARD_IMAGE_SCANNING=true
ORCHARD_OBJECT_STORAGE=true ORCHARD_MCP=true INGRESS_EXTRA_HOSTS='[]'
`;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'installer-'));
  const restarts = join(dir, 'restarts');
  for (const tool of ['systemctl', 'kubectl']) {
    const stub = join(dir, tool);
    writeFileSync(stub, `#!/bin/sh\necho "${tool} $*" >> "${restarts}"\nexit 0\n`);
    chmodSync(stub, 0o755);
  }
  const state = join(dir, 'state');
  const registries = join(dir, 'k3s', 'registries.yaml');
  const run = (script: string) => {
    const result = spawnSync('bash', ['-c', `${preamble}\n${script}`], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        ORCHARD_STATE_DIR: state,
        ORCHARD_REGISTRIES_FILE: registries
      }
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout + result.stderr;
  };
  const k3sRestarts = () =>
    existsSync(restarts)
      ? readFileSync(restarts, 'utf8')
          .split('\n')
          .filter((l) => l.startsWith('systemctl restart k3s')).length
      : 0;
  return {
    dir,
    state,
    registries,
    run,
    k3sRestarts,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

test('k3s only restarts when the registry mirror actually changed', () => {
  const box = sandbox();
  try {
    box.run('ensure_registry_mirror');
    assert.equal(box.k3sRestarts(), 1, 'the first run has to load the mirror');
    assert.match(readFileSync(box.registries, 'utf8'), /password: "sekret"/);

    box.run('ensure_registry_mirror');
    assert.equal(box.k3sRestarts(), 1, 'a re-run with the same mirror leaves k3s up');

    box.run('REGISTRY_PASSWORD=rotated; ensure_registry_mirror');
    assert.equal(box.k3sRestarts(), 2, 'new credentials need a reload');
  } finally {
    box.cleanup();
  }
});

test('a restart that never finished is retried on the next run', () => {
  const box = sandbox();
  try {
    const interrupted = spawnSync(
      'bash',
      ['-c', `${preamble}\nrestart_k3s() { return 1; }\nensure_registry_mirror`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${box.dir}:${process.env.PATH}`,
          ORCHARD_STATE_DIR: box.state,
          ORCHARD_REGISTRIES_FILE: box.registries
        }
      }
    );
    assert.notEqual(interrupted.status, 0);
    assert.ok(existsSync(box.registries), 'the file was written before the failure');

    box.run('ensure_registry_mirror');
    assert.equal(box.k3sRestarts(), 1, 'the same file still needs loading');
    assert.ok(!existsSync(join(box.state, 'k3s-restart-pending')));
  } finally {
    box.cleanup();
  }
});

test(
  're-running keeps env the installer does not manage',
  { skip: !has('yq', '--version') },
  () => {
    const box = sandbox();
    try {
      const values = join(box.state, 'values.yaml');
      const edit = `yq -i '
      .server.env += [
        {"name":"BASE_DOMAIN","value":"vanity.example.com"},
        {"name":"SMTP_PASS","valueFrom":{"secretKeyRef":{"name":"smtp","key":"pass"}}},
        {"name":"FRONTEND_URL","value":"https://stale.example.com"},
        {"name":"K8S_STORAGE_CLASS","value":"stale"}
      ] |
      .frontend.env += [
        {"name":"PUBLIC_FOO","value":"kept"},
        {"name":"PUBLIC_APP_DOMAIN","value":"stale"}
      ] |
      .mcp.env += [{"name":"MCP_FOO","value":"kept"}]
    ' "${values}"`;
      box.run(`mkdir -p "${box.state}"; write_values; ${edit}`);
      const secret = (name: string) =>
        execFileSync('yq', ['-r', `.server.env[] | select(.name == "${name}") | .value`, values], {
          encoding: 'utf8'
        }).trim();
      const jwt = secret('JWT_SECRET');
      const key = secret('SECRETS_ENCRYPTION_KEY');

      const output = box.run('write_values');
      assert.ok(!output.includes(jwt) && !output.includes(key), 'no secret reaches the output');

      const env = (list: string) =>
        JSON.parse(execFileSync('yq', ['-o=json', `.${list}.env`, values], { encoding: 'utf8' }));
      const names = (list: string) => env(list).map((e: { name: string }) => e.name);
      assert.equal(secret('JWT_SECRET'), jwt);
      assert.equal(secret('SECRETS_ENCRYPTION_KEY'), key);
      assert.equal(secret('BASE_DOMAIN'), 'vanity.example.com');
      assert.equal(secret('FRONTEND_URL'), 'https://orchard.example.com');
      assert.deepEqual(
        env('server').find((e: { name: string }) => e.name === 'SMTP_PASS').valueFrom,
        {
          secretKeyRef: { name: 'smtp', key: 'pass' }
        }
      );
      assert.ok(names('frontend').includes('PUBLIC_FOO'));
      assert.ok(names('mcp').includes('MCP_FOO'));
      assert.ok(!names('frontend').includes('PUBLIC_APP_DOMAIN'));
      assert.ok(!names('server').includes('K8S_STORAGE_CLASS'));
      for (const list of ['server', 'frontend', 'mcp']) {
        assert.equal(
          new Set(names(list)).size,
          names(list).length,
          `${list}.env has no duplicates`
        );
      }
      assert.deepEqual(
        execFileSync('ls', ['-A', box.state], { encoding: 'utf8' }).trim().split('\n'),
        ['values.yaml'],
        'no copy of the old values is left behind'
      );
    } finally {
      box.cleanup();
    }
  }
);

test(
  'a failed merge leaves the previous values in place',
  { skip: !has('yq', '--version') },
  () => {
    const box = sandbox();
    try {
      const values = join(box.state, 'values.yaml');
      box.run(`mkdir -p "${box.state}"; write_values`);
      const before = readFileSync(values, 'utf8');
      const failed = spawnSync('bash', ['-c', `${preamble}\nyq() { return 1; }\nwrite_values`], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${box.dir}:${process.env.PATH}`,
          ORCHARD_STATE_DIR: box.state,
          ORCHARD_REGISTRIES_FILE: box.registries
        }
      });
      assert.notEqual(failed.status, 0);
      assert.equal(readFileSync(values, 'utf8'), before);
    } finally {
      box.cleanup();
    }
  }
);

test(
  'the installer values reach the server with its issuer and a real frontend target',
  { skip: !has('yq', '--version') || !has('helm', 'version') },
  () => {
    const box = sandbox();
    try {
      const values = join(box.state, 'values.yaml');
      box.run(`mkdir -p "${box.state}"; write_values`);
      const out = execFileSync(
        'helm',
        ['template', 'orchard', chart, '--namespace', 'orchard', '-f', values],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
      );
      const server =
        out.split(/^---$/m).find((d) => /kind: Deployment/.test(d) && /name: server\n/.test(d)) ??
        '';
      assert.match(server, /name: CERT_CLUSTER_ISSUER, value: "letsencrypt"/);
      assert.match(server, /name: PLATFORM_NAMESPACE, value: "orchard"/);
      assert.match(server, /name: PLATFORM_SERVICE_NAME, value: "frontend"/);
      assert.match(server, /name: PLATFORM_SERVICE_PORT, value: "3000"/);
    } finally {
      box.cleanup();
    }
  }
);
