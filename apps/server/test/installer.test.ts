import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
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
ORCHARD_MCP_DOMAIN=mcp.example.com MAX_BUILDS=2 DB_DEFAULT_MEMORY_MB=1024 APP_DEFAULT_MEMORY_MB=1024 ARCH=amd64
REGISTRY_HOST=registry.local REGISTRY_PORT=5000 REGISTRY_USER=orchard REGISTRY_PASSWORD=sekret
BUILD_CACHE_GB=5 LOGS_SIZE_GB=5 LOGS_MAX_DISK_GB=4 OBJECT_STORAGE_GB=5 SMALL_BOX=false
ORCHARD_METRICS=true ORCHARD_LOGS=true ORCHARD_IMAGE_SCANNING=true
ORCHARD_OBJECT_STORAGE=true ORCHARD_MCP=true INGRESS_EXTRA_HOSTS='[]'
`;

function backups(state: string) {
  return readdirSync(state).filter((name) => /^values\.yaml\.\d{8}-\d{6}\.bak/.test(name));
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'installer-'));
  const restarts = join(dir, 'restarts');
  for (const tool of ['systemctl', 'kubectl']) {
    const stub = join(dir, tool);
    writeFileSync(stub, `#!/bin/sh\necho "${tool} $*" >> "${restarts}"\nexit 0\n`);
    chmodSync(stub, 0o755);
  }
  writeFileSync(
    join(dir, 'dig'),
    `#!/bin/bash
[ ! -f "${dir}/dns-down" ] || exit 9
for a in "$@"; do
  case "$a" in
    @*|+*) ;;
    A|AAAA|CNAME|NS|CAA) type=$a ;;
    *) name=$a ;;
  esac
done
[ -f "${dir}/dns-table" ] || exit 0
while read -r t n v; do
  if [ "$t" = "$type" ] && [ "$n" = "$name" ]; then printf '%s. 300 IN %s %s\\n' "$n" "$t" "$v"; fi
done < "${dir}/dns-table"
exit 0
`
  );
  writeFileSync(
    join(dir, 'getent'),
    `#!/bin/bash
[ -f "${dir}/dns-local" ] || exit 2
while read -r n v; do
  if [ "$n" = "$2" ]; then printf '%s STREAM %s\\n' "$v" "$n"; fi
done < "${dir}/dns-local"
exit 0
`
  );
  writeFileSync(join(dir, 'timeout'), '#!/bin/bash\nshift\nexec "$@"\n');
  writeFileSync(
    join(dir, 'curl'),
    '#!/bin/sh\nif [ "$1" = --version ]; then echo "curl 8.5.0 (x86_64)"; exit 0; fi\nexit 7\n'
  );
  for (const tool of ['dig', 'getent', 'timeout', 'curl']) chmodSync(join(dir, tool), 0o755);
  const state = join(dir, 'state');
  const registries = join(dir, 'k3s', 'registries.yaml');
  const attempt = (script: string) =>
    spawnSync('bash', ['-c', `${preamble}\n${script}`], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        KUBECONFIG: '/dev/null',
        ORCHARD_STATE_DIR: state,
        ORCHARD_REGISTRIES_FILE: registries,
        ORCHARD_DMI_DIR: join(dir, 'no-dmi')
      }
    });
  const run = (script: string) => {
    const result = attempt(script);
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
    attempt,
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
      assert.equal(
        secret('FRONTEND_URL'),
        'https://stale.example.com',
        'a value set by hand stays, and the last definition is the one the container sees'
      );
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
      assert.equal(backups(box.state).length, 1, 'one copy of the old values, and no temp files');
      assert.equal(readdirSync(box.state).length, 2);
    } finally {
      box.cleanup();
    }
  }
);

const stoppingCases: [string, string, RegExp][] = [
  ['yq fails outright', 'yq() { return 1; }', /can't read/],
  ['yq is missing', 'command() { [ "$2" != yq ] && builtin command "$@"; }', /yq isn't installed/],
  [
    'the merge itself fails',
    'real_yq=$(command -v yq); yq() { case "$*" in *load*) return 1 ;; esac; "$real_yq" "$@"; }',
    /could not merge/
  ]
];

for (const [name, stub, message] of stoppingCases) {
  test(
    `when ${name}, a re-run stops, keeps a copy and leaves the values in place`,
    { skip: !has('yq', '--version') },
    () => {
      const box = sandbox();
      try {
        const values = join(box.state, 'values.yaml');
        box.run(`mkdir -p "${box.state}"; write_values`);
        const before = readFileSync(values, 'utf8');
        const failed = box.attempt(`${stub}\nwrite_values`);
        assert.notEqual(failed.status, 0);
        assert.match(failed.stderr, message);
        assert.match(failed.stderr, /didn't change the file/);
        assert.equal(readFileSync(values, 'utf8'), before);
        const [copy] = backups(box.state);
        assert.equal(readFileSync(join(box.state, copy), 'utf8'), before);
        assert.equal(statSync(join(box.state, copy)).mode & 0o777, 0o600);
        assert.equal(readdirSync(box.state).length, 2, 'no temp files are left behind');
      } finally {
        box.cleanup();
      }
    }
  );
}

test(
  'a values file that does not parse stops the installer before it asks anything',
  { skip: !has('yq', '--version') },
  () => {
    const box = sandbox();
    try {
      const values = join(box.state, 'values.yaml');
      box.run(`mkdir -p "${box.state}"; write_values`);
      writeFileSync(values, 'server: [unclosed\n  : nope: {\n');
      for (const entry of ['load_previous_answers', 'write_values']) {
        const failed = box.attempt(`${entry}; echo got-past-it`);
        assert.notEqual(failed.status, 0, entry);
        assert.ok(!failed.stdout.includes('got-past-it'), entry);
        assert.match(failed.stderr, /valid YAML/);
        assert.match(failed.stderr, /Don't delete/);
        assert.equal(readFileSync(values, 'utf8'), 'server: [unclosed\n  : nope: {\n');
      }
      for (const copy of backups(box.state)) {
        assert.equal(statSync(join(box.state, copy)).mode & 0o777, 0o600);
      }
      assert.ok(backups(box.state).length >= 1);
    } finally {
      box.cleanup();
    }
  }
);

function readValues(box: ReturnType<typeof sandbox>) {
  const values = join(box.state, 'values.yaml');
  const read = (path: string) =>
    execFileSync('yq', ['-r', path, values], { encoding: 'utf8' }).trim();
  const env = (name: string, list = 'server') =>
    read(`.${list}.env[] | select(.name == "${name}") | .value`);
  return { values, read, env };
}

const handEdits = `yq -i '
  .signupMode = "open" |
  .tenant.ingressNamespaces = "traefik,orchard,mine" |
  .custom.chart.key = "kept" |
  .builders.httpRegistries = ["zot.orchard.svc.cluster.local:5000", "extra.local:5000"] |
  .server.env += [
    {"name":"HAND_ADDED","value":"kept"},
    {"name":"SMTP_PASS","valueFrom":{"secretKeyRef":{"name":"smtp","key":"pass"}}}
  ] |
  .frontend.env += [{"name":"PUBLIC_HAND_ADDED","value":"kept"}]
' "$VALUES_FILE"`;

const secretNames = ['JWT_SECRET', 'SECRETS_ENCRYPTION_KEY', 'SSO_ENCRYPTION_KEY'];

test(
  'a re-run keeps what changed since the install and leaves an unchanged file alone',
  { skip: !has('yq', '--version') },
  () => {
    const box = sandbox();
    try {
      const { values, read, env } = readValues(box);
      box.run(`mkdir -p "${box.state}"; write_values`);
      assert.equal(env('DATABASE_DEFAULT_MEMORY_MB'), '1024', 'a new install sizes its defaults');
      assert.match(readFileSync(values, 'utf8'), /^# Generated by install\/install\.sh/);
      const fresh = readFileSync(values, 'utf8');
      assert.match(box.run('load_previous_answers; write_values'), /No settings change/);
      assert.equal(readFileSync(values, 'utf8'), fresh, 'nothing to change, nothing rewritten');
      assert.equal(backups(box.state).length, 0);

      box.run(`${handEdits}
        yq -i '.objectStorage.local.enabled = false | .server.image.tag = "v1.2.3" | .frontend.image.tag = "v1.2.3"' "$VALUES_FILE"`);
      const before = secretNames.map((name) => env(name));
      const edited = readFileSync(values, 'utf8');
      const output = box.run('load_previous_answers; write_values');
      assert.match(output, /No settings change/);
      assert.match(output, /keep your value: .*signupMode/);
      assert.ok(!output.includes('HAND_ADDED'), 'env the installer never wrote is not a conflict');
      assert.equal(readFileSync(values, 'utf8'), edited);

      box.run(`load_previous_answers; ORCHARD_MCP_DOMAIN=agents.example.com; write_values`);
      assert.equal(read('.signupMode'), 'open');
      assert.equal(read('.tenant.ingressNamespaces'), 'traefik,orchard,mine');
      assert.equal(read('.custom.chart.key'), 'kept');
      assert.equal(read('.objectStorage.local.enabled'), 'false');
      assert.equal(read('.server.image.tag'), 'v1.2.3');
      assert.equal(read('.frontend.image.tag'), 'v1.2.3');
      assert.equal(env('HAND_ADDED'), 'kept');
      assert.equal(env('PUBLIC_HAND_ADDED', 'frontend'), 'kept');
      assert.equal(
        read('.server.env[] | select(.name == "SMTP_PASS") | .valueFrom.secretKeyRef.key'),
        'pass'
      );
      assert.equal(read('.builders.httpRegistries | length'), '2', 'other lists stay as a whole');
      assert.equal(read('.builders.httpRegistries[1]'), 'extra.local:5000');
      assert.deepEqual(
        secretNames.map((name) => env(name)),
        before
      );
      assert.equal(read('.mcp.env[] | select(.name == "JWT_SECRET") | .value'), before[0]);
      assert.equal(statSync(values).mode & 0o777, 0o600);
    } finally {
      box.cleanup();
    }
  }
);

test(
  'the merge runs under the shell options the installer itself uses',
  { skip: !has('yq', '--version') },
  () => {
    const box = sandbox();
    try {
      const { read } = readValues(box);
      box.run(`mkdir -p "${box.state}"; write_values; ${handEdits}`);
      assert.match(
        box.run('set -euo pipefail; load_previous_answers; write_values'),
        /No settings change/
      );
      assert.match(
        box.run(
          'set -euo pipefail; parse_args --domain new.example.com; load_previous_answers; write_values'
        ),
        /ingress\.host: orchard\.example\.com -> new\.example\.com/
      );
      assert.equal(read('.signupMode'), 'open');
    } finally {
      box.cleanup();
    }
  }
);

test(
  'a changed answer wins, its derived values follow, and the diff hides secret values',
  { skip: !has('yq', '--version') },
  () => {
    const box = sandbox();
    try {
      const { values, read, env } = readValues(box);
      box.run(`mkdir -p "${box.state}"; write_values; ${handEdits}`);
      box.run(
        `yq -i '(.server.env[] | select(.name == "FRONTEND_URL") | .value) = "https://hand.example.com" | .mcp.url = "https://hand-mcp.example.com"' "$VALUES_FILE"`
      );
      const before = secretNames.map((name) => env(name));
      const previous = readFileSync(values, 'utf8');

      const output = box.run(`
        parse_args --domain new.example.com --app-domain newapps.example.com --mcp-domain newmcp.example.com
        load_previous_answers
        write_values`);

      assert.equal(read('.ingress.host'), 'new.example.com');
      assert.equal(env('FRONTEND_URL'), 'https://new.example.com');
      assert.equal(env('APP_DOMAIN'), 'newapps.example.com');
      assert.equal(read('.gateway.http.appDomain'), 'newapps.example.com');
      assert.equal(read('.mcp.ingress.host'), 'newmcp.example.com');
      assert.equal(read('.mcp.url'), 'https://newmcp.example.com');
      assert.equal(read('.signupMode'), 'open');
      assert.equal(env('HAND_ADDED'), 'kept');
      assert.deepEqual(
        secretNames.map((name) => env(name)),
        before
      );

      assert.match(output, /ingress\.host: orchard\.example\.com -> new\.example\.com/);
      assert.match(
        output,
        /server\.env\.FRONTEND_URL: https:\/\/hand\.example\.com -> https:\/\/new\.example\.com/
      );
      assert.match(output, /keep your value: .*signupMode/);
      for (const secret of before) assert.ok(!output.includes(secret), 'no secret in the output');

      const [copy] = backups(box.state);
      assert.equal(readFileSync(join(box.state, copy), 'utf8'), previous);
      assert.equal(statSync(join(box.state, copy)).mode & 0o777, 0o600);
      assert.ok(output.includes(copy), 'the output says where the copy is');

      const lan = box.run(`
        parse_args --mode lan
        load_previous_answers
        INGRESS_MODE=lan
        apply_mode_settings
        write_values`);
      assert.equal(read('.ingress.tls.enabled'), 'false');
      assert.equal(read('.ingress.tls.issuerRef'), 'null', 'an answer can remove a key too');
      assert.equal(read('.mcp.ingress.tls.issuerRef'), 'null');
      assert.equal(read('.ingress.entryPoints[0]'), 'web');
      assert.equal(env('FRONTEND_URL'), 'http://new.example.com');
      assert.equal(env('SESSION_COOKIE_SECURE'), 'false');
      assert.equal(read('.tenant.certClusterIssuer'), 'selfsigned');
      assert.equal(read('.signupMode'), 'open');
      assert.match(lan, /ingress\.tls\.issuerRef\.name: removed/);
    } finally {
      box.cleanup();
    }
  }
);

test(
  'new defaults reach an older file, without undoing what its owner turned off',
  { skip: !has('yq', '--version') },
  () => {
    const box = sandbox();
    try {
      const { values, read, env } = readValues(box);
      box.run(`mkdir -p "${box.state}"; write_values`);
      const jwt = env('JWT_SECRET');
      const token = env('MCP_SERVICE_TOKEN');
      box.run(`yq -i '
        .hostDefaults = 1 |
        .metrics.enabled = false |
        .signupMode = "closed" |
        del(.logs.retention) |
        del(.trivy) |
        del(.server.env[] | select(.name == "CNPG_OPERATOR_NAMESPACE" or .name == "MCP_SERVICE_TOKEN")) |
        del(.mcp.env[] | select(.name == "MCP_SERVICE_TOKEN"))
      ' "$VALUES_FILE"`);

      const output = box.run('load_previous_answers; write_values');

      assert.equal(read('.hostDefaults'), '2');
      assert.equal(env('CNPG_OPERATOR_NAMESPACE'), 'cnpg-system');
      assert.equal(read('.logs.retention'), '14d');
      assert.equal(read('.trivy.enabled'), 'true');
      assert.equal(read('.metrics.enabled'), 'false', 'off stays off');
      assert.equal(read('.signupMode'), 'closed');
      assert.equal(env('JWT_SECRET'), jwt);

      const minted = env('MCP_SERVICE_TOKEN');
      assert.notEqual(minted, token, 'a secret that was missing is minted');
      assert.equal(env('MCP_SERVICE_TOKEN', 'mcp'), minted);
      assert.match(output, /server\.env\.MCP_SERVICE_TOKEN: added, value hidden/);
      assert.ok(!output.includes(minted), 'a minted secret stays out of the output');
      assert.match(output, /logs\.retention: added as 14d/);
      assert.match(output, /server\.env\.CNPG_OPERATOR_NAMESPACE: added as cnpg-system/);

      box.run(`yq -i '.hostDefaults = 9' "$VALUES_FILE"`);
      const newer = readFileSync(values, 'utf8');
      box.run('load_previous_answers; write_values');
      assert.equal(readFileSync(values, 'utf8'), newer, 'a later round is not lowered');
    } finally {
      box.cleanup();
    }
  }
);

test(
  'a re-run changes or clears a pinned public IP and keeps the limits choice',
  { skip: !has('yq', '--version') },
  () => {
    const box = sandbox();
    try {
      const { read, env } = readValues(box);
      box.run(`mkdir -p "${box.state}"; ORCHARD_LIMITS=on; write_values`);
      box.run(`yq -i '.tenant.publicIp = "198.51.100.7"' "$VALUES_FILE"`);

      box.run('load_previous_answers; write_values');
      assert.equal(read('.tenant.publicIp'), '198.51.100.7');
      assert.equal(env('INSTANCE_RESOURCE_LIMITS_CHOICE'), 'on');

      box.run(
        'parse_args --limits off; load_previous_answers; ORCHARD_PUBLIC_IP=203.0.113.9; write_values'
      );
      assert.equal(read('.tenant.publicIp'), '203.0.113.9');
      assert.equal(env('INSTANCE_RESOURCE_LIMITS_CHOICE'), 'off');

      box.run('load_previous_answers; ORCHARD_PUBLIC_IP=; write_values');
      assert.equal(read('.tenant.publicIp'), 'null');
      assert.equal(env('INSTANCE_RESOURCE_LIMITS_CHOICE'), 'off');
    } finally {
      box.cleanup();
    }
  }
);

for (const [mode, setup, host] of [
  ['public', 'USE_TLS=true CERT_ISSUER=letsencrypt', 'https://new.example.com'],
  ['tunnel', 'USE_TLS=false CERT_ISSUER=', 'https://new.example.com'],
  ['lan', 'USE_TLS=false CERT_ISSUER=selfsigned', 'http://new.example.com']
] as const) {
  test(
    `the chart renders merged ${mode} values with the settings kept`,
    { skip: !has('yq', '--version') || !has('helm', 'version') },
    () => {
      const box = sandbox();
      try {
        const { values, env } = readValues(box);
        box.run(`mkdir -p "${box.state}"
          ${setup} INGRESS_MODE=${mode}
          write_values
          ${handEdits}
          ${setup} INGRESS_MODE=${mode}
          parse_args --domain new.example.com
          load_previous_answers
          write_values`);
        assert.equal(env('FRONTEND_URL'), host);
        const out = execFileSync(
          'helm',
          ['template', 'orchard', chart, '--namespace', 'orchard', '-f', values],
          { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
        );
        assert.ok(out.includes('Host(`new.example.com`)'), 'the route follows the new domain');
        assert.match(out, /SIGNUP_MODE[^\n]*\n?[^\n]*open/);
        assert.match(out, /name: HAND_ADDED/);
        assert.match(out, /secretKeyRef/);
      } finally {
        box.cleanup();
      }
    }
  );
}

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

test(
  'a re-run keeps every answer unless a flag changes it',
  { skip: !has('yq', '--version') },
  () => {
    const box = sandbox();
    try {
      const values = join(box.state, 'values.yaml');
      const edit = `yq -i '
        .ingress.host = "kept.example.com" |
        .ingress.extraHosts = ["mango", "mango.tail.ts.net"] |
        .mcp.ingress.host = "agents.example.com" |
        .mcp.enabled = false |
        .metrics.enabled = false |
        .tenant.publicIp = "198.51.100.7" |
        (.server.env[] | select(.name == "APP_DOMAIN") | .value) = "kept-apps.example.com"
      ' "${values}"`;
      box.run(`mkdir -p "${box.state}"; write_values; ${edit}`);
      const answers = `printf '%s|' "$ORCHARD_INGRESS_MODE" "$ORCHARD_DOMAIN" "$ORCHARD_APP_DOMAIN" "$ORCHARD_MCP_DOMAIN" "$ORCHARD_MCP" "$ORCHARD_METRICS" "$PREVIOUS_INSTALL" "$PREVIOUS_EXTRA_HOSTS"`;
      const clean = `ORCHARD_INGRESS_MODE= ORCHARD_DOMAIN= ORCHARD_APP_DOMAIN= ORCHARD_MCP_DOMAIN= ORCHARD_MCP=true ORCHARD_METRICS=true`;

      assert.match(
        box.run(`${clean}; load_previous_answers; ${answers}`),
        /public\|kept\.example\.com\|kept-apps\.example\.com\|agents\.example\.com\|false\|false\|true\|mango mango\.tail\.ts\.net \|/
      );

      assert.match(
        box.run(
          `${clean}; parse_args --domain new.example.com --mcp true; ORCHARD_DOMAIN=new.example.com; load_previous_answers; ${answers}`
        ),
        /public\|new\.example\.com\|kept-apps\.example\.com\|agents\.example\.com\|true\|false\|/
      );

      box.run(
        `${clean}; load_previous_answers; INGRESS_EXTRA_HOSTS='["mango", "mango.tail.ts.net"]'; write_values`
      );
      const read = (path: string) =>
        execFileSync('yq', ['-r', path, values], { encoding: 'utf8' }).trim();
      assert.equal(read('.tenant.publicIp'), '198.51.100.7');
      assert.equal(read('.ingress.host'), 'kept.example.com');
      assert.equal(read('.mcp.ingress.host'), 'agents.example.com');
      assert.equal(read('.mcp.enabled'), 'false');
      assert.equal(read('.ingress.extraHosts[1]'), 'mango.tail.ts.net');
    } finally {
      box.cleanup();
    }
  }
);

test(
  'a re-run keeps the ingress mode it finds in the values',
  { skip: !has('yq', '--version') },
  () => {
    const box = sandbox();
    try {
      const cases: [string, string][] = [
        ['USE_TLS=true INGRESS_MODE=public', 'public'],
        ['USE_TLS=false INGRESS_MODE=tunnel CERT_ISSUER=', 'tunnel'],
        ['USE_TLS=false INGRESS_MODE=lan CERT_ISSUER=selfsigned', 'lan']
      ];
      for (const [setup, want] of cases) {
        rmSync(box.state, { recursive: true, force: true });
        box.run(`mkdir -p "${box.state}"; ${setup}; write_values`);
        const out = box.run(
          'ORCHARD_INGRESS_MODE=; load_previous_answers; printf "mode=%s" "$ORCHARD_INGRESS_MODE"'
        );
        assert.ok(out.includes(`mode=${want}`), `${want}: ${out}`);
      }
    } finally {
      box.cleanup();
    }
  }
);

test('the update policy defaults to manual and rejects anything else', () => {
  const box = sandbox();
  try {
    assert.match(
      box.run(
        'ORCHARD_UPDATE_POLICY=; choose_update_policy; printf "got=%s" "$ORCHARD_UPDATE_POLICY"'
      ),
      /got=manual/
    );
    assert.match(
      box.run(
        'ORCHARD_UPDATE_POLICY=; PREVIOUS_INSTALL=true; choose_update_policy; printf "got=%s" "$ORCHARD_UPDATE_POLICY"'
      ),
      /got=automatic/,
      'a timer already enabled on this box is kept'
    );
    const refused = spawnSync(
      'bash',
      ['-c', `${preamble}\nORCHARD_UPDATE_POLICY=sometimes; choose_update_policy`],
      { encoding: 'utf8' }
    );
    assert.notEqual(refused.status, 0);
  } finally {
    box.cleanup();
  }
});

test('the default domains follow the dashboard until someone types one', () => {
  const box = sandbox();
  try {
    const derive = (domain: string, extra = '') =>
      box.run(`
        INGRESS_MODE=public ORCHARD_PUBLIC_IP=203.0.113.10
        ORCHARD_DOMAIN=${domain} ORCHARD_APP_DOMAIN= ORCHARD_MCP_DOMAIN=
        ${extra}
        mark_given_answers
        derive_answers
        printf 'apps=%s mcp=%s cname=%s\\n' "$ORCHARD_APP_DOMAIN" "$ORCHARD_MCP_DOMAIN" "$ORCHARD_INGRESS_CNAME"
      `);
    assert.match(
      derive('orchard.example.com'),
      /apps=apps\.example\.com mcp=mcp\.example\.com cname=orchard\.example\.com/
    );
    assert.match(derive('example.com'), /apps=apps\.example\.com mcp=mcp\.example\.com/);
    assert.match(derive('example.co.uk'), /apps=apps\.example\.co\.uk/);
    assert.match(derive('orchard.example.co.uk'), /apps=apps\.example\.co\.uk/);
    assert.match(derive('mcp.example.com'), /mcp=agents\.example\.com/);
    assert.match(
      derive(
        'orchard.example.com',
        'ORCHARD_MCP_DOMAIN=ai.other.dev ORCHARD_APP_DOMAIN=run.other.dev'
      ),
      /apps=run\.other\.dev mcp=ai\.other\.dev/
    );
  } finally {
    box.cleanup();
  }
});

test('the Lets Encrypt issuer is valid with and without an email', () => {
  const box = sandbox();
  try {
    const issuer = (setup: string) => {
      const log = join(box.dir, 'applied');
      writeFileSync(
        join(box.dir, 'kubectl'),
        `#!/bin/sh\ncase "$1" in\n  apply) cat > "${log}" ;;\n  get) printf '%s' "$LIVE_EMAIL" ;;\nesac\nexit 0\n`
      );
      box.run(`CERT_ISSUER=letsencrypt; ${setup}; install_cluster_issuer`);
      return readFileSync(log, 'utf8');
    };
    assert.ok(!issuer('ORCHARD_ACME_EMAIL=').includes('email:'));
    assert.match(issuer('ORCHARD_ACME_EMAIL=me@example.com'), /\n {4}email: me@example\.com\n/);
    assert.match(
      issuer('export LIVE_EMAIL=kept@example.com; ORCHARD_ACME_EMAIL='),
      /email: kept@example\.com/,
      'a re-run keeps the address the account was registered with'
    );
  } finally {
    box.cleanup();
  }
});

for (const [mode, setup, mcpHost] of [
  ['public', 'USE_TLS=true CERT_ISSUER=letsencrypt', 'mcp.apps.example.com'],
  ['tunnel', 'USE_TLS=false CERT_ISSUER=', 'mcp.apps.example.com'],
  ['lan', 'USE_TLS=false CERT_ISSUER=selfsigned', 'mcp.apps.example.com']
] as const) {
  for (const mcp of ['true', 'false']) {
    test(
      `the chart renders the ${mode} values with the MCP ${mcp === 'true' ? 'on' : 'off'}`,
      { skip: !has('yq', '--version') || !has('helm', 'version') },
      () => {
        const box = sandbox();
        try {
          const values = join(box.state, 'values.yaml');
          box.run(`mkdir -p "${box.state}"
            ${setup} INGRESS_MODE=${mode} ORCHARD_MCP=${mcp} ORCHARD_MCP_DOMAIN=${mcpHost}
            write_values`);
          const out = execFileSync(
            'helm',
            ['template', 'orchard', chart, '--namespace', 'orchard', '-f', values],
            { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
          );
          if (mcp === 'true') {
            assert.ok(out.includes(`Host(\`${mcpHost}\`)`), 'the MCP gets a route on its host');
            assert.match(
              out,
              /name: MCP_BASE_URL, value:/,
              'the server knows the MCP host, which is what reserves it from apps'
            );
          } else {
            assert.ok(!out.includes(`Host(\`${mcpHost}\`)`), 'no route with the MCP off');
          }
        } finally {
          box.cleanup();
        }
      }
    );
  }
}

test(
  'the custom domains target stays out of the values, so the admin page can edit it',
  { skip: !has('yq', '--version') },
  () => {
    const box = sandbox();
    try {
      const values = join(box.state, 'values.yaml');
      const cname = () =>
        execFileSync(
          'yq',
          ['-r', '.server.env[] | select(.name == "INGRESS_CNAME") | .value', values],
          { encoding: 'utf8' }
        ).trim();

      box.run(`mkdir -p "${box.state}"; ORCHARD_INGRESS_CNAME=orchard.example.com; write_values`);
      assert.equal(cname(), '', 'a new install does not pin it');

      execFileSync('yq', [
        '-i',
        '.server.env += [{"name":"INGRESS_CNAME","value":"edge.example.com"}]',
        values
      ]);
      box.run('load_previous_answers; ORCHARD_DOMAIN=other.example.com; write_values');
      assert.equal(cname(), 'edge.example.com', 'one pinned by hand is left alone');

      box.run('load_previous_answers; ORCHARD_INGRESS_CNAME=new.example.com; write_values');
      assert.equal(cname(), 'new.example.com', 'changing a pinned one updates the pin');

      box.run('load_previous_answers; ORCHARD_INGRESS_CNAME=; write_values');
      assert.equal(cname(), '', 'clearing a pinned one removes the pin');

      const tokenOut = box.run(
        `USE_TLS=false CERT_ISSUER= INGRESS_MODE=tunnel ORCHARD_TUNNEL_TOKEN=${Buffer.from(
          JSON.stringify({ t: '8a1b2c3d-0000-4000-8000-000000000001' })
        ).toString('base64')}; printf 'got=%s' "$(ingress_cname)"`
      );
      assert.match(tokenOut, /got=8a1b2c3d-0000-4000-8000-000000000001\.cfargotunnel\.com/);
      assert.match(
        box.run(
          'INGRESS_MODE=tunnel ORCHARD_TUNNEL_TOKEN=not-a-token; printf "got=[%s]" "$(ingress_cname)"'
        ),
        /got=\[\]/
      );
      assert.match(
        box.run('INGRESS_MODE=lan PRIMARY_IP=192.168.1.5; printf "got=%s" "$(ingress_cname)"'),
        /got=orchard\.192-168-1-5\.sslip\.io/
      );
    } finally {
      box.cleanup();
    }
  }
);

test('the public IP and custom domains target are saved where the admin page can edit them', () => {
  const box = sandbox();
  try {
    const save = (setup: string) => {
      const log = join(box.dir, 'restarts');
      rmSync(log, { force: true });
      box.run(
        `mkdir -p "${box.state}"; ORCHARD_PUBLIC_IP=203.0.113.10 ORCHARD_INGRESS_CNAME=orchard.example.com; ${setup}; save_install_settings`
      );
      return existsSync(log) ? readFileSync(log, 'utf8') : '';
    };
    const pending = join(box.state, 'settings-pending');
    const arm = 'touch "$STATE_DIR/settings-pending"';

    assert.match(
      save(arm),
      /install-settings\.js seed --public-ip 203\.0\.113\.10 --cname orchard\.example\.com/,
      'a new install seeds both'
    );
    assert.ok(!existsSync(pending));

    const noChange = save('PREV_PUBLIC_IP=203.0.113.10 PREV_CNAME=orchard.example.com');
    assert.ok(!/install-settings/.test(noChange), 'a re-run with no change writes nothing');

    assert.match(
      save('PREV_PUBLIC_IP=198.51.100.1 PREV_CNAME=orchard.example.com'),
      /seed --force --public-ip 203\.0\.113\.10\n/,
      'a change overwrites, and only what changed'
    );
    assert.match(
      save('PREV_PUBLIC_IP=198.51.100.1 PREV_CNAME=orchard.example.com ORCHARD_PUBLIC_IP='),
      /seed --force --public-ip \n/,
      'clearing it clears it'
    );
    assert.ok(
      !/install-settings/.test(save(`${arm}; ORCHARD_PUBLIC_IP= ORCHARD_INGRESS_CNAME=`)),
      'blank answers on a new install seed nothing'
    );
    assert.ok(!existsSync(pending));

    writeFileSync(join(box.dir, 'kubectl'), '#!/bin/sh\nexit 1\n');
    const failed = box.run(
      `mkdir -p "${box.state}"; ORCHARD_PUBLIC_IP=203.0.113.10; ${arm}; save_install_settings`
    );
    assert.match(failed, /Instance admin > Configuration/);
    assert.ok(existsSync(pending), 'a failure stays pending for the next run');
  } finally {
    box.cleanup();
  }
});

test('sslip.io names work for IPv4 and need no records', () => {
  const box = sandbox();
  try {
    const out = box.run(`
      INGRESS_MODE=public ORCHARD_PUBLIC_IP=203.0.113.10
      ORCHARD_DOMAIN= ORCHARD_APP_DOMAIN= ORCHARD_MCP_DOMAIN=
      PUBLIC_IP_SET=true
      derive_answers
      printf 'ui=%s apps=%s mcp=%s\\n' "$ORCHARD_DOMAIN" "$ORCHARD_APP_DOMAIN" "$ORCHARD_MCP_DOMAIN"
    `);
    assert.match(
      out,
      /ui=orchard\.203-0-113-10\.sslip\.io apps=apps\.203-0-113-10\.sslip\.io mcp=mcp\.203-0-113-10\.sslip\.io/
    );
  } finally {
    box.cleanup();
  }
});

test(
  'moving off sslip.io re-derives the app, MCP and custom domain names',
  { skip: !has('yq', '--version') },
  () => {
    const box = sandbox();
    try {
      box.run(`mkdir -p "${box.state}"
      ORCHARD_DOMAIN=orchard.203-0-113-10.sslip.io
      ORCHARD_APP_DOMAIN=apps.203-0-113-10.sslip.io
      ORCHARD_MCP_DOMAIN=mcp.203-0-113-10.sslip.io
      write_values`);
      const moved = box.run(`
      ORCHARD_DOMAIN= ORCHARD_APP_DOMAIN= ORCHARD_MCP_DOMAIN= ASSUME_YES=true
      ORCHARD_PUBLIC_IP=203.0.113.10
      parse_args --domain orchard.example.com
      load_previous_answers
      collect_answers
      dns_step
      write_values
      printf 'apps=%s mcp=%s cname=%s' "$ORCHARD_APP_DOMAIN" "$ORCHARD_MCP_DOMAIN" "$ORCHARD_INGRESS_CNAME"
    `);
      assert.match(
        moved,
        /apps=apps\.example\.com mcp=mcp\.example\.com cname=orchard\.example\.com/
      );
      assert.match(moved, /Create these DNS records/);
      assert.match(
        moved,
        /Dashboard moves from orchard\.203-0-113-10\.sslip\.io to orchard\.example\.com/
      );
      const env = (name: string) =>
        execFileSync(
          'yq',
          [
            '-r',
            `.server.env[] | select(.name == "${name}") | .value`,
            join(box.state, 'values.yaml')
          ],
          { encoding: 'utf8' }
        ).trim();
      assert.equal(env('FRONTEND_URL'), 'https://orchard.example.com');
      assert.equal(env('APP_DOMAIN'), 'apps.example.com');
    } finally {
      box.cleanup();
    }
  }
);

test('the summary says what is configured, what is pending, what is next, and how to change it', () => {
  const box = sandbox();
  try {
    writeFileSync(
      join(box.dir, 'kubectl'),
      `#!/bin/sh
case "$*" in
  *challenges*) printf 'Timeout during connect (likely firewall problem)' ;;
  *orders*) ;;
  *) printf False ;;
esac
`
    );
    const out = box.run(`
      ORCHARD_DOMAIN=orchard.example.com ORCHARD_APP_DOMAIN=apps.example.com ORCHARD_MCP_DOMAIN=mcp.apps.example.com
      ORCHARD_PUBLIC_IP=203.0.113.10 ORCHARD_INGRESS_CNAME=orchard.example.com
      ORCHARD_UPDATE_POLICY=manual STEP_N=0 CLOUD=aws
      orchard-claim() { return 1; }
      summary
    `);
    assert.match(out, /Orchard is installed/);
    assert.match(out, /Configured/);
    assert.match(out, /Public IP: 203\.0\.113\.10/);
    assert.match(out, /Custom domains target: orchard\.example\.com/);
    assert.match(out, /Still pending/);
    assert.match(out, /DNS: orchard\.example\.com \(waiting\)/);
    assert.match(out, /DNS: \*\.apps\.example\.com \(waiting\)/);
    assert.match(out, /Certificate: not issued yet/);
    assert.match(out, /security group/, 'a firewall failure names the provider firewall');
    assert.match(out, /retries on its own/);
    assert.match(out, /passkey or a password/);
    assert.match(out, /GitHub App/);
    assert.match(out, /Change these later/);
    assert.match(out, /Instance admin > Configuration/);
    assert.match(out, /--updates automatic/);
    assert.ok(
      !/[\u2013\u2014]/.test(readFileSync(installer, 'utf8')),
      'no em dashes in the installer'
    );

    writeFileSync(join(box.dir, 'kubectl'), '#!/bin/sh\nprintf True\n');
    const ready = box.run(`
      ORCHARD_DOMAIN=orchard.203-0-113-10.sslip.io ORCHARD_APP_DOMAIN=apps.203-0-113-10.sslip.io
      ORCHARD_MCP_DOMAIN=mcp.203-0-113-10.sslip.io ORCHARD_UPDATE_POLICY=manual STEP_N=0
      orchard-claim() { return 1; }
      summary
    `);
    assert.match(ready, /Orchard is ready/);
    assert.ok(!/Still pending/.test(ready));
    assert.match(ready, /--domain <host>/);
  } finally {
    box.cleanup();
  }
});

test(
  'a re-run on the same domain does not repeat the DNS instructions',
  { skip: !has('yq', '--version') },
  () => {
    const box = sandbox();
    try {
      box.run(`mkdir -p "${box.state}"; write_values`);
      const out = box.run(`
        ORCHARD_DOMAIN= ORCHARD_APP_DOMAIN= ORCHARD_MCP_DOMAIN= ASSUME_YES=true
        load_previous_answers
        collect_answers
        dns_step
      `);
      assert.ok(!/Create these DNS records/.test(out));
      assert.match(out, /aren't listed again/);
    } finally {
      box.cleanup();
    }
  }
);

function fakeCurlBox(answerByMethod: string) {
  const box = sandbox();
  writeFileSync(
    join(box.dir, 'curl'),
    `#!/bin/bash
if [ "$1" = --version ]; then echo "curl 8.5.0 (x86_64)"; exit 0; fi
input=$(cat)
echo "$*" >> "${box.dir}/curl.args"
case "$input" in *'very-secret'*) ;; *) echo "secret not on stdin" >> "${box.dir}/curl.args" ;; esac
method=GET
prev=''
for a in "$@"; do [ "$prev" = -X ] && method=$a; prev=$a; done
${answerByMethod}
`
  );
  chmodSync(join(box.dir, 'curl'), 0o755);
  return box;
}

const S3_FLAGS = `ORCHARD_S3_ENDPOINT=https://s3.example.com ORCHARD_S3_BUCKET=mine ORCHARD_S3_REGION=eu
ORCHARD_S3_ACCESS_KEY=AK ORCHARD_S3_SECRET_KEY=very-secret ASSUME_YES=true`;

test('--yes with no S3 settings asks nothing and keeps backups local', () => {
  const box = sandbox();
  const out = box.run(`ASSUME_YES=true; choose_s3_storage; echo "ready=$S3_READY"`);
  assert.match(out, /ready=false/);
});

test('--no-s3 skips storage even with settings present', () => {
  const box = sandbox();
  const out = box.run(`${S3_FLAGS} ORCHARD_S3=false; choose_s3_storage; echo "ready=$S3_READY"`);
  assert.match(out, /ready=false/);
});

test('working S3 settings pass the live test, and the secret never reaches argv', () => {
  const box = fakeCurlBox(`printf 200`);
  const out = box.run(`${S3_FLAGS}; choose_s3_storage; echo "ready=$S3_READY"`);
  assert.match(out, /ready=true/);
  const args = readFileSync(join(box.dir, 'curl.args'), 'utf8');
  assert.doesNotMatch(args, /very-secret/);
  assert.doesNotMatch(args, /secret not on stdin/);
  assert.match(args, /aws:amz:eu:s3/);
  assert.match(args, /https:\/\/s3\.example\.com\/mine\/\?list-type=2/);
  assert.match(args, /-X PUT .*mine\/\.orchard-connection-test/);
  assert.match(args, /-X DELETE/);
});

test('virtual-host style moves the bucket into the hostname', () => {
  const box = fakeCurlBox(`printf 200`);
  box.run(`${S3_FLAGS} ORCHARD_S3_PATH_STYLE=false; choose_s3_storage`);
  const args = readFileSync(join(box.dir, 'curl.args'), 'utf8');
  assert.match(args, /https:\/\/mine\.s3\.example\.com\/\?list-type=2/);
});

test('a failed S3 test never aborts a non-interactive install', () => {
  const box = fakeCurlBox(`printf 403`);
  const out = box.run(`${S3_FLAGS}; choose_s3_storage; echo "ready=$S3_READY rc=$?"`);
  assert.match(out, /ready=false rc=0/);
  assert.match(out, /the key was refused/);
  assert.match(out, /continuing without S3/);
  assert.doesNotMatch(out, /very-secret/);
});

test('a read-only key fails at the write step', () => {
  const box = fakeCurlBox(`if [ "$method" = PUT ]; then printf 403; else printf 200; fi`);
  const out = box.run(`${S3_FLAGS}; choose_s3_storage; echo "ready=$S3_READY"`);
  assert.match(out, /ready=false/);
});

test('an unreachable endpoint is reported and skipped', () => {
  const box = fakeCurlBox(`exit 7`);
  const out = box.run(`${S3_FLAGS}; choose_s3_storage; echo "ready=$S3_READY"`);
  assert.match(out, /couldn't connect/);
  assert.match(out, /ready=false/);
});

test('the store bucket name and missing fields are refused before any request', () => {
  const box = fakeCurlBox(`printf 200`);
  const named = box.run(`${S3_FLAGS} ORCHARD_S3_BUCKET=orchard-backups; choose_s3_storage`);
  assert.match(named, /used by the store on this server/);
  const missing = box.run(`${S3_FLAGS} ORCHARD_S3_SECRET_KEY=; choose_s3_storage`);
  assert.match(missing, /no secret key/);
  assert.equal(existsSync(join(box.dir, 'curl.args')), false);
});

test('a secret key file is read, and an old curl does not block the install', () => {
  const box = sandbox();
  writeFileSync(join(box.dir, 'curl'), '#!/bin/sh\necho "curl 7.68.0 (x86_64)"\n');
  chmodSync(join(box.dir, 'curl'), 0o755);
  writeFileSync(join(box.dir, 'secret'), 'from-file\n');
  const out = box.run(
    `ORCHARD_S3_ENDPOINT=https://s3.example.com ORCHARD_S3_BUCKET=mine ORCHARD_S3_ACCESS_KEY=AK ASSUME_YES=true
ORCHARD_S3_SECRET_KEY_FILE=${join(box.dir, 'secret')}; choose_s3_storage; echo "secret=$ORCHARD_S3_SECRET_KEY ready=$S3_READY"`
  );
  assert.match(out, /secret=from-file ready=true/);
  assert.match(out, /too old to test/);
});

test('a failure saving S3 settings only warns', () => {
  const box = sandbox();
  writeFileSync(join(box.dir, 'orchardctl'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(box.dir, 'orchardctl'), 0o755);
  const out = box.run(`${S3_FLAGS} S3_READY=true; apply_s3_storage; echo "ready=$S3_READY rc=$?"`);
  assert.match(out, /couldn't save the S3 settings/);
  assert.match(out, /ready=false rc=0/);
});

test('saving passes the secret through the environment, not the arguments', () => {
  const box = sandbox();
  writeFileSync(
    join(box.dir, 'orchardctl'),
    `#!/bin/sh\necho "$* key=$ORCHARD_S3_SECRET_KEY" > "${box.dir}/ctl.args"\n`
  );
  chmodSync(join(box.dir, 'orchardctl'), 0o755);
  box.run(`${S3_FLAGS} ORCHARD_S3_PATH_STYLE=false S3_READY=true; apply_s3_storage`);
  const args = readFileSync(join(box.dir, 'ctl.args'), 'utf8');
  assert.match(
    args,
    /backups s3 set --endpoint https:\/\/s3\.example\.com --bucket mine --region eu --path-style false key=very-secret/
  );
});

test('a fresh install keeps a daily control-plane dump in the local store, an old box does not gain one', () => {
  const box = sandbox();
  const fresh = box.run(`PREVIOUS_INSTALL=false; control_plane_dump_values`);
  assert.match(fresh, /prefix: _control-plane/);
  assert.match(fresh, /name: orchard-db-app/);
  assert.match(fresh, /keep: 7/);
  const old = box.run(`PREVIOUS_INSTALL=true; control_plane_dump_values`);
  assert.doesNotMatch(old, /_control-plane/);
  const none = box.run(
    `PREVIOUS_INSTALL=false ORCHARD_OBJECT_STORAGE=false; control_plane_dump_values`
  );
  assert.doesNotMatch(none, /_control-plane/);
});

function unwrap(text: string) {
  return text.replace(/ ?\n {13}/g, ' ');
}

function dnsBox(table: string, localTable = '') {
  const box = sandbox();
  writeFileSync(join(box.dir, 'dns-table'), table);
  writeFileSync(join(box.dir, 'dns-local'), localTable);
  return box;
}

const CF_TOKEN = Buffer.from(
  JSON.stringify({ a: 'acct', t: '8a1b2c3d-0000-4000-8000-000000000001', s: 'c2VjcmV0' })
).toString('base64');

const PUBLIC_BOX = `
ORCHARD_PUBLIC_IP=203.0.113.10 ORCHARD_INGRESS_CNAME=orchard.example.com
ORCHARD_APP_DOMAIN=apps.example.com ORCHARD_MCP_DOMAIN=mcp.apps.example.com
LOCAL_IPS=203.0.113.10 PRIMARY_IP=203.0.113.10 BEHIND_NAT=false ASSUME_YES=true
port_state() { printf refused; }
`;

function dnsOutput(table: string, extra = '', localTable = '') {
  const box = dnsBox(table, localTable);
  try {
    return unwrap(
      box.run(`${PUBLIC_BOX}
      ${extra}
      build_dns_records
      dns_check_all
      printf 'PENDING=%s' "$(one_line "$DNS_PENDING")"
    `)
    );
  } finally {
    box.cleanup();
  }
}

const GOOD = `A orchard.example.com 203.0.113.10
A orchard-dns-probe.apps.example.com 203.0.113.10
NS example.com ns1.example.net
`;

test('--help lists every answer with its flag and variable', () => {
  const out = spawnSync('bash', [installer, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, KUBECONFIG: '/dev/null', ORCHARD_STATE_DIR: '/nonexistent' }
  }).stdout;
  for (const [flag, env] of [
    ['--mode', 'ORCHARD_INGRESS_MODE'],
    ['--tunnel-token', 'ORCHARD_TUNNEL_TOKEN'],
    ['--public-ip', 'ORCHARD_PUBLIC_IP'],
    ['--domain', 'ORCHARD_DOMAIN'],
    ['--app-domain', 'ORCHARD_APP_DOMAIN'],
    ['--ingress-cname', 'ORCHARD_INGRESS_CNAME'],
    ['--mcp-domain', 'ORCHARD_MCP_DOMAIN'],
    ['--mcp', 'ORCHARD_MCP'],
    ['--email', 'ORCHARD_ACME_EMAIL'],
    ['--updates', 'ORCHARD_UPDATE_POLICY'],
    ['--limits', 'ORCHARD_LIMITS'],
    ['--yes', 'ORCHARD_ASSUME_YES']
  ]) {
    assert.ok(out.includes(flag), flag);
    assert.ok(out.includes(env), env);
  }
});

test('records come from the answers, with a wildcard line', () => {
  const box = dnsBox('');
  try {
    const out = box.run(`${PUBLIC_BOX}
      build_dns_records
      print_dns_records
    `);
    assert.match(out, /A\s+orchard\.example\.com\s+203\.0\.113\.10/);
    assert.match(out, /A\s+\*\.apps\.example\.com\s+203\.0\.113\.10/);
    assert.ok(!/mcp\.apps/.test(out), 'the wildcard covers the MCP');

    const own = box.run(`${PUBLIC_BOX}
      ORCHARD_MCP_DOMAIN=agents.other.dev ORCHARD_INGRESS_CNAME=edge.example.com
      build_dns_records
      print_dns_records
    `);
    assert.match(own, /A\s+agents\.other\.dev/, 'a name outside the wildcard gets its own record');
    assert.match(own, /A\s+edge\.example\.com/, 'so does a custom CNAME target');

    const nested = box.run(`${PUBLIC_BOX}
      ORCHARD_MCP_DOMAIN=a.b.apps.example.com
      build_dns_records
      print_dns_records
    `);
    assert.match(nested, /A\s+a\.b\.apps\.example\.com/, 'a wildcard covers one label only');

    const off = box.run(`${PUBLIC_BOX}
      ORCHARD_MCP=false ORCHARD_MCP_DOMAIN=agents.other.dev
      build_dns_records
      print_dns_records
    `);
    assert.ok(!/agents\.other\.dev/.test(off), 'no record with the MCP off');

    const v6 = box.run(`${PUBLIC_BOX}
      ORCHARD_PUBLIC_IP=2001:db8::10
      build_dns_records
      print_dns_records
    `);
    assert.match(v6, /AAAA\s+orchard\.example\.com\s+2001:db8::10/);

    const sslip = box.run(`${PUBLIC_BOX}
      ORCHARD_DOMAIN=orchard.203-0-113-10.sslip.io ORCHARD_APP_DOMAIN=apps.203-0-113-10.sslip.io
      ORCHARD_MCP_DOMAIN=mcp.203-0-113-10.sslip.io ORCHARD_INGRESS_CNAME=orchard.203-0-113-10.sslip.io
      build_dns_records
      printf 'count=%s' "\${#RECORD_NAMES[@]}"
    `);
    assert.match(sslip, /count=0/);
  } finally {
    box.cleanup();
  }
});

test('a record that points at this box resolves', () => {
  const out = dnsOutput(GOOD);
  assert.match(out, /resolves\s+orchard\.example\.com/);
  assert.match(out, /resolves\s+\*\.apps\.example\.com/);
  assert.match(out, /PENDING=$/m);
});

test('a missing record is waiting, and says what to do about wildcards', () => {
  const out = dnsOutput('A orchard.example.com 203.0.113.10\n');
  assert.match(out, /waiting\s+\*\.apps\.example\.com/);
  assert.match(out, /doesn't allow wildcard records/);
  assert.match(out, /one record for each app/);
  assert.match(out, /PENDING=\*\.apps\.example\.com \(waiting\)/);
});

test('a record pointing elsewhere is a wrong value, with the address it found', () => {
  const out = dnsOutput(`A orchard.example.com 198.51.100.4
A orchard-dns-probe.apps.example.com 203.0.113.10
`);
  assert.match(out, /wrong value\s+orchard\.example\.com/);
  assert.match(out, /points at 198\.51\.100\.4, not 203\.0\.113\.10/);
  assert.match(out, /old TTL/);
});

test('an orange cloud is recognised as the proxy, not a wrong record', () => {
  const out = dnsOutput(`A orchard.example.com 104.21.3.4
A orchard.example.com 172.67.1.2
A orchard-dns-probe.apps.example.com 104.21.3.4
`);
  assert.match(out, /proxied\s+orchard\.example\.com/);
  assert.match(out, /orange cloud/);
  assert.match(out, /Always Use HTTPS/);
  assert.match(out, /DNS only/);
  assert.equal(out.match(/orange cloud/g)?.length, 1, 'the explanation appears once');
  assert.ok(!/wrong value/.test(out));
});

test('a private target is called out, public DNS or not', () => {
  const out = dnsOutput(`A orchard.example.com 10.0.0.5
A orchard-dns-probe.apps.example.com 203.0.113.10
`);
  assert.match(out, /wrong value\s+orchard\.example\.com/);
  assert.match(out, /private address/);
  assert.match(out, /lan mode/);
});

test('split-horizon DNS shows both answers, and public DNS decides', () => {
  const splitPublicOk = dnsOutput(GOOD, '', 'orchard.example.com 10.0.0.5\n');
  assert.match(splitPublicOk, /resolves\s+orchard\.example\.com/);
  assert.match(splitPublicOk, /still resolves it to 10\.0\.0\.5/);
  assert.match(splitPublicOk, /cached answer or split-horizon/);

  const onlyLocal = dnsOutput(
    'A orchard-dns-probe.apps.example.com 203.0.113.10\n',
    '',
    'orchard.example.com 10.0.0.5\n'
  );
  assert.match(onlyLocal, /waiting\s+orchard\.example\.com/);
  assert.match(onlyLocal, /public DNS has no answer/);
  assert.match(onlyLocal, /Let's Encrypt only sees public DNS/);
});

test('an apex that already has a site warns before moving it', () => {
  const out = dnsOutput(
    `A example.com 198.51.100.9
NS example.com ns1.example.net
A orchard-dns-probe.apps.example.com 203.0.113.10
`,
    'ORCHARD_DOMAIN=example.com ORCHARD_INGRESS_CNAME=example.com'
  );
  assert.match(out, /wrong value\s+example\.com/);
  assert.match(out, /top of its zone/);
  assert.match(out, /probably a website/);
  assert.match(out, /orchard\.example\.com/);
});

test('extra addresses on a right record are reported', () => {
  const out = dnsOutput(`A orchard.example.com 203.0.113.10
A orchard.example.com 198.51.100.9
A orchard-dns-probe.apps.example.com 203.0.113.10
`);
  assert.match(out, /resolves\s+orchard\.example\.com/);
  assert.match(out, /other addresses/);
});

test('an IPv6-only box checks AAAA and explains a stray A record', () => {
  const ok = dnsOutput(
    `AAAA orchard.example.com 2001:db8::10
AAAA orchard-dns-probe.apps.example.com 2001:db8::10
`,
    'ORCHARD_PUBLIC_IP=2001:db8::10'
  );
  assert.match(ok, /resolves\s+orchard\.example\.com/);
  assert.match(ok, /PENDING=$/m);

  const stray = dnsOutput(
    `A orchard.example.com 203.0.113.10
AAAA orchard-dns-probe.apps.example.com 2001:db8::10
`,
    'ORCHARD_PUBLIC_IP=2001:db8::10'
  );
  assert.match(stray, /wrong value\s+orchard\.example\.com/);
  assert.match(stray, /has an A record/);
});

test('a resolver blocked from here falls back to DNS over HTTPS, then says it could not check', () => {
  const box = dnsBox('');
  try {
    writeFileSync(join(box.dir, 'dns-down'), '');
    writeFileSync(
      join(box.dir, 'curl'),
      `#!/bin/sh
case "$*" in
  *type=A*) printf '{"Status":0,"Answer":[{"name":"x.","type":5,"TTL":1,"data":"alias.example."},{"name":"alias.example.","type":1,"TTL":1,"data":"203.0.113.10"}]}' ;;
  *) printf '{"Status":0}' ;;
esac
`
    );
    const out = box.run(`${PUBLIC_BOX}
      build_dns_records
      dns_check_all
    `);
    assert.match(out, /resolves\s+orchard\.example\.com/, out);

    writeFileSync(join(box.dir, 'curl'), '#!/bin/sh\nexit 7\n');
    const blind = box.run(`${PUBLIC_BOX}
      build_dns_records
      dns_check_all
      printf 'PENDING=%s' "$(one_line "$DNS_PENDING")"
    `);
    assert.match(blind, /not checked\s+orchard\.example\.com/);
    assert.match(blind, /No public resolver could be reached/);
    assert.match(blind, /PENDING=.*not checked/);
  } finally {
    box.cleanup();
  }
});

test('the zone report names the panel, a delegated subdomain and a bad CAA', () => {
  const box = dnsBox(`NS example.com ns1.example.net
NS lab.example.com ns1.other.dev
CAA lab.example.com 0 issue "digicert.com"
`);
  try {
    const out = box.run(`${PUBLIC_BOX}
      ORCHARD_DOMAIN=orchard.lab.example.com ORCHARD_APP_DOMAIN=apps.lab.example.com
      ORCHARD_INGRESS_CNAME=orchard.lab.example.com
      build_dns_records
      dns_zone_report
      dns_caa_report
    `);
    assert.match(out, /DNS panel for lab\.example\.com/);
    assert.match(out, /ns1\.other\.dev/);
    assert.match(out, /delegated away from example\.com/);
    assert.match(out, /CAA records that don't allow Let's Encrypt/);

    const unregistered = box.run(`${PUBLIC_BOX}
      ORCHARD_DOMAIN=orchard.nothing.test ORCHARD_APP_DOMAIN=apps.nothing.test
      ORCHARD_INGRESS_CNAME=orchard.nothing.test
      build_dns_records
      dns_zone_report
    `);
    assert.match(unregistered, /No nameservers answer/);
  } finally {
    box.cleanup();
  }
});

test('a CAA record above a name counts, and the nearest one wins', () => {
  const box = dnsBox(`NS example.com ns1.example.net
CAA example.com 0 issue "digicert.com"
CAA ok.example.com 0 issue "letsencrypt.org"
`);
  try {
    const blocked = box.run(`${PUBLIC_BOX}
      RECORD_NAMES=(orchard.dev.example.com)
      dns_caa_report
    `);
    assert.match(blocked, /example\.com has CAA records that don't allow Let's Encrypt/);

    const allowed = box.run(`${PUBLIC_BOX}
      RECORD_NAMES=(orchard.ok.example.com)
      dns_caa_report
    `);
    assert.ok(!/CAA records/.test(allowed), allowed);
  } finally {
    box.cleanup();
  }
});

test('tunnel mode warns about names the free certificate does not cover', () => {
  const box = dnsBox(`NS example.com ns1.example.net
`);
  try {
    const deep = box.run(`
      INGRESS_MODE=tunnel
      RECORD_NAMES=(orchard.dev.example.com '*.apps.example.com')
      dns_tunnel_cert_report
    `);
    assert.match(deep, /orchard\.dev\.example\.com is more than one level under example\.com/);
    assert.match(deep, /\*\.apps\.example\.com is more than one level under example\.com/);
    assert.match(deep, /Advanced Certificate Manager/);

    const covered = box.run(`
      INGRESS_MODE=tunnel
      RECORD_NAMES=(orchard.example.com '*.example.com' example.com)
      dns_tunnel_cert_report
    `);
    assert.ok(!/more than one level/.test(covered), covered);
  } finally {
    box.cleanup();
  }
});

test('the tunnel HTTPS probe only reports a refused handshake', () => {
  const box = dnsBox('');
  try {
    writeFileSync(join(box.dir, 'curl'), '#!/bin/sh\nexit 35\n');
    chmodSync(join(box.dir, 'curl'), 0o755);
    const refused = box.run(`
      sleep() { :; }
      ORCHARD_DOMAIN=orchard.dev.example.com ORCHARD_APP_DOMAIN=dev.example.com ORCHARD_MCP=false
      printf 'FAILED=%s\n' "$(tunnel_tls_failures)"
    `);
    assert.match(refused, /FAILED=orchard\.dev\.example\.com orchard-dns-probe\.dev\.example\.com/);

    writeFileSync(join(box.dir, 'curl'), '#!/bin/sh\nexit 28\n');
    const slow = box.run(`
      ORCHARD_DOMAIN=orchard.dev.example.com ORCHARD_APP_DOMAIN=dev.example.com ORCHARD_MCP=false
      printf 'FAILED=%s\n' "$(tunnel_tls_failures)"
    `);
    assert.match(slow, /FAILED=$/m);
  } finally {
    box.cleanup();
  }
});

test('a firewall in front of the box is named per provider', () => {
  const box = dnsBox('');
  try {
    const blocked = box.run(`${PUBLIC_BOX}
      LOCAL_IPS=10.0.0.5 CLOUD=aws
      port_state() { printf blocked; }
      check_reachability
    `);
    assert.match(blocked, /Nothing answered on 203\.0\.113\.10 port 80 and 443/);
    assert.match(blocked, /AWS, allow 80 and 443 in the security group/);

    const open = box.run(`${PUBLIC_BOX}
      LOCAL_IPS=10.0.0.5
      port_state() { printf refused; }
      check_reachability
    `);
    assert.match(open, /get through from this machine/);

    const direct = box.run(`${PUBLIC_BOX}
      check_reachability
    `);
    assert.match(direct, /a test from here can't check the firewall/);

    assert.match(box.run(`CLOUD=oracle; firewall_hint`), /iptables/);
    assert.match(box.run(`CLOUD=hetzner; firewall_hint`), /Cloud Console > Firewalls/);
    assert.match(box.run(`CLOUD=gcp; firewall_hint`), /VPC network > Firewall/);
    assert.match(box.run(`CLOUD=azure; firewall_hint`), /network security group/);
    assert.match(box.run(`CLOUD=; firewall_hint`), /forward them on your router/);
  } finally {
    box.cleanup();
  }
});

test('the provider comes from DMI', () => {
  const box = sandbox();
  try {
    writeFileSync(join(box.dir, 'sys_vendor'), 'Amazon EC2\n');
    assert.match(box.run(`DMI_DIR="${box.dir}"; printf 'got=%s' "$(cloud_provider)"`), /got=aws/);
    writeFileSync(join(box.dir, 'sys_vendor'), 'QEMU\n');
    writeFileSync(join(box.dir, 'chassis_asset_tag'), 'OracleCloud.com\n');
    assert.match(
      box.run(`DMI_DIR="${box.dir}"; printf 'got=%s' "$(cloud_provider)"`),
      /got=oracle/
    );
  } finally {
    box.cleanup();
  }
});

test('address helpers cover the edges', () => {
  const box = sandbox();
  try {
    const yes = (fn: string, value: string) =>
      assert.match(
        box.run(`if ${fn} "${value}"; then echo got=yes; else echo got=no; fi`),
        /got=yes/,
        `${fn} ${value}`
      );
    const no = (fn: string, value: string) =>
      assert.match(
        box.run(`if ${fn} "${value}"; then echo got=yes; else echo got=no; fi`),
        /got=no/,
        `${fn} ${value}`
      );
    yes('is_ipv4', '203.0.113.10');
    no('is_ipv4', '300.1.1.1');
    no('is_ipv4', '<html>');
    yes('is_ipv6', '2001:db8::10');
    no('is_ipv6', 'abc');
    yes('is_private_ip', '10.1.2.3');
    yes('is_private_ip', '172.20.0.1');
    no('is_private_ip', '172.32.0.1');
    yes('is_private_ip', '100.100.1.1');
    yes('is_private_ip', 'fd7a:115c::1');
    no('is_private_ip', '203.0.113.10');
    yes('is_cloudflare_ip', '104.21.3.4');
    yes('is_cloudflare_ip', '172.67.1.2');
    yes('is_cloudflare_ip', '2606:4700:3030::1');
    no('is_cloudflare_ip', '203.0.113.10');
    yes('valid_host', 'orchard.example.com');
    no('valid_host', 'orchard');
    no('valid_host', '-bad.example.com');
    no('valid_host', '203.0.113.10');
    no('valid_host', 'under_score.example.com');
    yes('valid_lan_host', 'mango');
    yes('valid_lan_host', '192.168.1.5');
    yes('valid_lan_host', 'mango.tail.ts.net');
    assert.match(
      box.run(`printf 'got=%s' "$(clean_host 'HTTPS://Orchard.Example.com/')"`),
      /got=orchard\.example\.com/
    );
    assert.match(
      box.run(`printf 'got=%s' "$(clean_host '*.apps.example.com.')"`),
      /got=apps\.example\.com/
    );
    assert.match(
      box.run(`printf 'got=%s' "$(sslip_name orchard 2001:db8::10)"`),
      /got=orchard\.2001-db8--10\.sslip\.io/
    );
    assert.match(
      box.run(`printf 'got=%s' "$(sslip_name orchard 2001:db8::)"`),
      /got=orchard\.2001-db8--0\.sslip\.io/
    );
    assert.match(
      box.run(`printf 'got=%s' "$(email_problem me@example.com)"`),
      /refuses addresses at example\.com/
    );
    assert.match(box.run(`printf 'got=%s' "$(email_problem nope)"`), /isn't an email address/);
    assert.match(box.run(`printf 'got=[%s]' "$(email_problem me@sub.real.dev)"`), /got=\[\]/);
  } finally {
    box.cleanup();
  }
});

type Flow = { status: number | null; out: string; box: ReturnType<typeof sandbox> };

const FRESH_NET =
  'PUBLIC_IP=203.0.113.10 LOCAL_IPS=203.0.113.10 PRIMARY_IP=203.0.113.10 BEHIND_NAT=false';

function flow(
  answers: string[],
  setup = FRESH_NET,
  table = '',
  keep?: ReturnType<typeof sandbox>
): Flow {
  const box = keep ?? dnsBox(table);
  if (keep) writeFileSync(join(box.dir, 'dns-table'), table);
  const input = join(box.dir, 'answers');
  writeFileSync(input, answers.map((a) => `${a}\n`).join(''));
  const result = spawnSync(
    'bash',
    [
      '-c',
      `export ORCHARD_LIB_ONLY=1 NO_COLOR=1 ORCHARD_NO_PACING=1
      source "${installer}"
      step() { :; }
      port_state() { printf refused; }
      exec 3<"${input}"
      PROMPT_FD_OPEN=true
      HTTP_SUFFIX= HTTPS_SUFFIX=
      ${setup}
      load_previous_answers
      collect_answers
      dns_step
      printf '\\nRESULT mode=%s ip=%s ui=%s apps=%s cname=%s mcp=%s host=%s email=%s updates=%s limits=%s tls=%s issuer=%s\\n' \
        "$INGRESS_MODE" "$ORCHARD_PUBLIC_IP" "$ORCHARD_DOMAIN" "$ORCHARD_APP_DOMAIN" "$ORCHARD_INGRESS_CNAME" \
        "$ORCHARD_MCP" "$ORCHARD_MCP_DOMAIN" "$ORCHARD_ACME_EMAIL" "$ORCHARD_UPDATE_POLICY" "$ORCHARD_LIMITS" "$USE_TLS" "$CERT_ISSUER"
      printf 'SKIPPED=%s PENDING=%s\\n' "$DNS_SKIPPED" "$(one_line "$DNS_PENDING")"`
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${box.dir}:${process.env.PATH}`,
        KUBECONFIG: '/dev/null',
        ORCHARD_STATE_DIR: box.state,
        ORCHARD_REGISTRIES_FILE: box.registries,
        ORCHARD_DMI_DIR: join(box.dir, 'no-dmi')
      }
    }
  );
  return { status: result.status, out: unwrap(result.stdout + result.stderr), box };
}

test('every question runs in order and Enter accepts each default', () => {
  const { status, out, box } = flow(['', '', '', '', '', '', '', '', '', '', '', '', '2']);
  try {
    assert.equal(status, 0, out);
    const order = [
      'How should traffic reach this machine?',
      'Public IP',
      'Dashboard domain',
      'Apps domain',
      'Custom domains target',
      'MCP endpoint',
      "Let's Encrypt email",
      'Updates',
      'Off-server storage',
      'Review'
    ];
    let at = 0;
    for (const title of order) {
      const found = out.indexOf(title, at);
      assert.ok(found >= at, `${title} comes in order:\n${out}`);
      at = found;
    }
    assert.match(out, /Recommended: public\. 203\.0\.113\.10 is on this machine/);
    assert.match(out, /1 of 9  How should traffic/);
    assert.match(out, /9 of 9/);
    assert.match(out, /share one Let's Encrypt limit/);
    assert.match(
      out,
      /RESULT mode=public ip=203\.0\.113\.10 ui=orchard\.203-0-113-10\.sslip\.io apps=apps\.203-0-113-10\.sslip\.io cname=orchard\.203-0-113-10\.sslip\.io mcp=true host=mcp\.203-0-113-10\.sslip\.io email= updates=manual limits= tls=true issuer=letsencrypt/
    );
    assert.match(out, /no DNS records to add/);
    assert.ok(!existsSync(join(box.state, 'values.yaml')), 'nothing is written before the install');
  } finally {
    box.cleanup();
  }
});

test('typed answers land where they should, and domains follow until someone types one', () => {
  const table = `A orchard.example.com 198.51.100.20
A orchard-dns-probe.apps.example.com 198.51.100.20
`;
  const { status, out, box } = flow(
    [
      'public',
      '198.51.100.20',
      'orchard.example.com',
      '',
      'edge.example.com',
      'y',
      'agents.other.dev',
      'bad',
      'me@real.dev',
      'automatic',
      '',
      '',
      '2'
    ],
    FRESH_NET,
    table
  );
  try {
    assert.equal(status, 0, out);
    assert.match(
      out,
      /RESULT mode=public ip=198\.51\.100\.20 ui=orchard\.example\.com apps=apps\.example\.com cname=edge\.example\.com mcp=true host=agents\.other\.dev email=me@real\.dev updates=automatic/
    );
    assert.match(out, /that isn't an email address/);
    assert.match(out, /A\s+agents\.other\.dev\s+198\.51\.100\.20/);
    assert.match(out, /A\s+edge\.example\.com\s+198\.51\.100\.20/);
    assert.match(out, /needs its own DNS record/);
    assert.match(out, /waiting\s+agents\.other\.dev/);
    assert.match(out, /Continue anyway/);
    assert.match(out, /PENDING=agents\.other\.dev \(waiting\) edge\.example\.com \(waiting\)/);
  } finally {
    box.cleanup();
  }
});

test('MCP can be declined, and a name under the wildcard says so', () => {
  const off = flow(
    ['public', '', 'orchard.example.com', '', '', 'n', '', '', '', '', '2'],
    FRESH_NET
  );
  try {
    assert.equal(off.status, 0, off.out);
    assert.match(off.out, /mcp=false/);
    assert.match(off.out, /MCP endpoint\s+off/);
    assert.ok(!/MCP hostname/.test(off.out));
  } finally {
    off.box.cleanup();
  }

  const under = flow([
    'public',
    '',
    'orchard.example.com',
    '',
    '',
    'y',
    'ai.apps.example.com',
    '',
    '',
    '',
    '',
    '2'
  ]);
  try {
    assert.equal(under.status, 0, under.out);
    assert.match(under.out, /host=ai\.apps\.example\.com/);
    assert.match(under.out, /No extra DNS record\. Orchard reserves this name/);
    assert.ok(!/A\s+ai\.apps\.example\.com/.test(under.out));
  } finally {
    under.box.cleanup();
  }
});

test('the review screen edits one answer, and domains re-derive around it', () => {
  const { status, out, box } = flow([
    'public',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '3',
    'orchard.example.com',
    '',
    '2'
  ]);
  try {
    assert.equal(status, 0, out);
    assert.match(
      out,
      /ui=orchard\.example\.com apps=apps\.example\.com cname=orchard\.example\.com mcp=true host=mcp\.example\.com/
    );
    assert.equal(out.match(/\n {2}Review\n/g)?.length, 2, 'it comes back to the review');
  } finally {
    box.cleanup();
  }
});

test('cancel on the review screen installs nothing', () => {
  const { status, out, box } = flow(['public', '', '', '', '', '', '', '', '', '', 'c']);
  try {
    assert.equal(status, 0, out);
    assert.match(out, /Canceled\. Nothing was installed/);
    assert.ok(!/RESULT/.test(out));
  } finally {
    box.cleanup();
  }
});

test('the DNS step re-checks, and running out of input continues rather than aborts', () => {
  const table = 'A orchard.example.com 203.0.113.10\n';
  const answers = ['public', '', 'orchard.example.com', '', '', '', '', '', '', '', '', '1'];
  const { status, out, box } = flow(answers, FRESH_NET, table);
  try {
    assert.equal(status, 0, out);
    assert.equal(out.match(/Checking public DNS/g)?.length, 2);
    assert.match(out, /Create these DNS records/);
    assert.match(out, /PENDING=\*\.apps\.example\.com \(waiting\)/);
  } finally {
    box.cleanup();
  }
});

test('skipping DNS says what breaks and records it', () => {
  const answers = ['public', '', 'orchard.example.com', '', '', '', '', '', '', '', '', '3'];
  const { status, out, box } = flow(answers);
  try {
    assert.equal(status, 0, out);
    assert.match(out, /first sign-in link/);
    assert.match(out, /Certificates retry on their own/);
    assert.match(out, /SKIPPED=true/);
  } finally {
    box.cleanup();
  }
});

test('option 4 on the DNS step goes back to the answers', () => {
  const answers = [
    'public',
    '',
    'orchard.example.com',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '4',
    '3',
    'orchard.203-0-113-10.sslip.io',
    ''
  ];
  const { status, out, box } = flow(answers);
  try {
    assert.equal(status, 0, out);
    assert.match(out, /ui=orchard\.203-0-113-10\.sslip\.io/);
    assert.match(out, /PENDING=\s*$/m);
  } finally {
    box.cleanup();
  }
});

test('tunnel mode prints routes and CNAMEs to the tunnel, and defaults to it', () => {
  const answers = ['tunnel', CF_TOKEN, '', 'orchard.example.com', '', '', '', '', '', '', '', '2'];
  const table = `A orchard.example.com 104.21.3.4
A orchard-dns-probe.example.com 198.51.100.4
`;
  const { status, out, box } = flow(answers, FRESH_NET, table);
  try {
    assert.equal(status, 0, out);
    assert.match(out, /Tunnel mode carries web traffic only/);
    assert.match(
      out,
      /CNAME\s+orchard\.example\.com\s+8a1b2c3d-0000-4000-8000-000000000001\.cfargotunnel\.com/
    );
    assert.match(out, /CNAME\s+\*\.example\.com\s+8a1b2c3d/);
    assert.match(out, /Public Hostname/);
    assert.match(out, /http:\/\/traefik\.traefik\.svc\.cluster\.local:80/);
    assert.match(out, /Add the wildcard by hand/);
    assert.match(out, /Advanced Certificate\s+Manager/);
    assert.match(out, /cname=8a1b2c3d-0000-4000-8000-000000000001\.cfargotunnel\.com/);
    assert.match(out, /ip= /);
    assert.match(out, /tls=false issuer=/);
    assert.match(out, /resolves\s+orchard\.example\.com/);
    assert.match(out, /Cloudflare hides the target/);
    assert.match(out, /wrong value\s+\*\.example\.com/);
    assert.ok(!/Let's Encrypt email/.test(out), 'tunnel mode has no Lets Encrypt');
  } finally {
    box.cleanup();
  }
});

test('lan mode explains Tailscale and .local and needs no public DNS', () => {
  const answers = ['lan', '', '', '', '', '', '', '', '', ''];
  const setup = 'PUBLIC_IP= LOCAL_IPS=192.168.1.5 PRIMARY_IP=192.168.1.5 BEHIND_NAT=true';
  const { status, out, box } = flow(answers, setup);
  try {
    assert.equal(status, 0, out);
    assert.match(out, /Recommended: lan/);
    assert.match(
      out,
      /ui=192\.168\.1\.5 apps=apps\.192-168-1-5\.sslip\.io cname=orchard\.192-168-1-5\.sslip\.io mcp=true host=mcp\.192-168-1-5\.sslip\.io/
    );
    assert.match(out, /ip=192\.168\.1\.5/);
    assert.match(out, /no public DNS/i);
    assert.match(out, /Tailscale/);
    assert.match(out, /\.local names/);
    assert.ok(!/Create these DNS records/.test(out));
    assert.ok(!/Let's Encrypt email/.test(out));
    assert.match(out, /tls=false issuer=selfsigned/);
  } finally {
    box.cleanup();
  }
});

test('NAT, several interfaces, none detected and IPv6-only each get their own wording', () => {
  const nat = flow(
    ['public', '', '', '', '', '', '', '', '', '', ''],
    'PUBLIC_IP=203.0.113.10 LOCAL_IPS="10.0.0.5 10.0.1.5" PRIMARY_IP=10.0.0.5 BEHIND_NAT=true CLOUD=aws'
  );
  try {
    assert.equal(nat.status, 0, nat.out);
    assert.match(nat.out, /Recommended: public\. This looks like a cloud server/);
    assert.match(nat.out, /1:1 NAT/);
    assert.match(nat.out, /Addresses on this machine: 10\.0\.0\.5 10\.0\.1\.5/);
    assert.match(nat.out, /ip=203\.0\.113\.10/);
  } finally {
    nat.box.cleanup();
  }

  const home = flow(
    ['', CF_TOKEN, '', 'orchard.example.com', '', '', '', '', '', '', '', '2'],
    'PUBLIC_IP=203.0.113.10 LOCAL_IPS=192.168.1.5 PRIMARY_IP=192.168.1.5 BEHIND_NAT=true'
  );
  try {
    assert.equal(home.status, 0, home.out);
    assert.match(home.out, /Recommended: tunnel\. This machine is behind NAT/);
  } finally {
    home.box.cleanup();
  }

  const none = flow(
    ['public', '', 'orchard.example.com', '', '', '', '', '', '', '', '', '2'],
    'PUBLIC_IP= LOCAL_IPS=10.0.0.5 PRIMARY_IP=10.0.0.5 BEHIND_NAT=true'
  );
  try {
    assert.equal(none.status, 0, none.out);
    assert.match(none.out, /No public address was found/);
    assert.match(none.out, /stay unavailable until you set it under Instance admin/);
    assert.match(none.out, /ip= ui=orchard\.example\.com/);
    assert.match(none.out, /not set, public ports and databases are unavailable/);
    assert.match(none.out, /<your public IP>/);
  } finally {
    none.box.cleanup();
  }

  const v6 = flow(
    ['public', '', '', '', '', '', '', '', '', '', ''],
    'PUBLIC_IP= PUBLIC_IP6=2001:db8::10 LOCAL_IPS= LOCAL_IPS6=2001:db8::10 PRIMARY_IP= BEHIND_NAT=false'
  );
  try {
    assert.equal(v6.status, 0, v6.out);
    assert.match(v6.out, /No public IPv4 address was found/);
    assert.match(v6.out, /listens on IPv4 only/);
    assert.match(v6.out, /ip=2001:db8::10 ui=orchard\.2001-db8--10\.sslip\.io/);
  } finally {
    v6.box.cleanup();
  }

  const dual = flow(
    ['public', '', 'orchard.example.com', '', '', '', '', '', '', '', '', '2'],
    'PUBLIC_IP=203.0.113.10 PUBLIC_IP6=2001:db8::10 LOCAL_IPS=203.0.113.10 LOCAL_IPS6=2001:db8::10 PRIMARY_IP=203.0.113.10 BEHIND_NAT=false'
  );
  try {
    assert.equal(dual.status, 0, dual.out);
    assert.match(dual.out, /Don't add AAAA records/);
  } finally {
    dual.box.cleanup();
  }
});

const IPV6_ONLY =
  'PUBLIC_IP= PUBLIC_IP6=2001:db8::10 LOCAL_IPS= LOCAL_IPS6=2001:db8::10 PRIMARY_IP=';

function ipv4Check(setup: string, args = '') {
  const box = sandbox();
  try {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `export ORCHARD_LIB_ONLY=1 NO_COLOR=1 ORCHARD_NO_PACING=1
        source "${installer}"
        parse_args ${args}
        ${setup}
        require_ipv4
        echo CONTINUED`
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${box.dir}:${process.env.PATH}`,
          KUBECONFIG: '/dev/null',
          ORCHARD_STATE_DIR: box.state
        }
      }
    );
    return { status: result.status, out: result.stdout + result.stderr };
  } finally {
    box.cleanup();
  }
}

test('a server with no IPv4 address stops and says what does not work', () => {
  const { status, out } = ipv4Check(IPV6_ONLY);
  assert.equal(status, 1);
  assert.match(out, /IPv6-only servers aren't supported yet/);
  assert.match(out, /GitHub and ghcr\.io have no IPv6 addresses/);
  assert.match(out, /Use a server with an IPv4 address/);
  assert.match(out, /NAT64/);
  assert.match(out, /--allow-ipv6-only/);
  assert.match(out, /stopped before installing anything/);
  assert.doesNotMatch(out, /CONTINUED/);
  assert.doesNotMatch(out, /AAAA/);
});

test('--yes does not get past the IPv4 check, and --allow-ipv6-only does', () => {
  const yes = ipv4Check(IPV6_ONLY, '--yes');
  assert.equal(yes.status, 1);
  assert.doesNotMatch(yes.out, /CONTINUED/);

  const flag = ipv4Check(IPV6_ONLY, '--allow-ipv6-only');
  assert.equal(flag.status, 0, flag.out);
  assert.match(flag.out, /IPv6-only servers aren't supported yet/);
  assert.match(flag.out, /Continuing because of --allow-ipv6-only/);
  assert.match(flag.out, /CONTINUED/);

  const env = ipv4Check(`${IPV6_ONLY} ALLOW_IPV6_ONLY=true`);
  assert.equal(env.status, 0, env.out);
});

test('any IPv4 address passes the check, and nothing is said about it', () => {
  for (const setup of [
    'PUBLIC_IP=203.0.113.10 PUBLIC_IP6=2001:db8::10 LOCAL_IPS=203.0.113.10 LOCAL_IPS6=2001:db8::10 PRIMARY_IP=203.0.113.10',
    'PUBLIC_IP= PUBLIC_IP6=2001:db8::10 LOCAL_IPS=10.0.0.5 LOCAL_IPS6=2001:db8::10 PRIMARY_IP=10.0.0.5',
    'PUBLIC_IP=203.0.113.10 PUBLIC_IP6= LOCAL_IPS= LOCAL_IPS6= PRIMARY_IP=',
    'PUBLIC_IP= PUBLIC_IP6= LOCAL_IPS= LOCAL_IPS6= PRIMARY_IP='
  ]) {
    const { status, out } = ipv4Check(setup);
    assert.equal(status, 0, `${setup}\n${out}`);
    assert.equal(out.trim(), 'CONTINUED', setup);
  }
});

test('the IPv4 check runs before any question and before anything is installed', () => {
  const source = readFileSync(installer, 'utf8');
  const main = source.slice(source.indexOf('\nmain() {'));
  const order = ['preflight', 'detect_network', 'require_ipv4', 'collect_answers', 'install_k3s'];
  const places = order.map((name) => main.indexOf(`\n  ${name}\n`));
  assert.ok(!places.includes(-1), `main calls each of ${order.join(', ')}`);
  assert.deepEqual(
    places,
    [...places].sort((a, b) => a - b)
  );
});

test('--help names the flag for IPv6-only servers', () => {
  const out = spawnSync('bash', [installer, '--help'], { encoding: 'utf8' }).stdout;
  assert.match(out, /--allow-ipv6-only/);
  assert.match(out, /ORCHARD_ALLOW_IPV6_ONLY/);
  assert.match(out, /--yes doesn't imply it/);
});

test('--yes never prompts, never waits on DNS, and required answers name their flag', () => {
  const box = dnsBox('');
  try {
    const yes = flow([], `${FRESH_NET} ASSUME_YES=true`, '', box);
    assert.equal(yes.status, 0, yes.out);
    assert.match(
      yes.out,
      /RESULT mode=public ip=203\.0\.113\.10 ui=orchard\.203-0-113-10\.sslip\.io/
    );
    assert.ok(!/Enter installs/.test(yes.out));

    const own = flow(
      [],
      `${FRESH_NET} ASSUME_YES=true; parse_args --domain orchard.example.com`,
      '',
      box
    );
    assert.equal(own.status, 0, own.out);
    assert.match(own.out, /doesn't wait for DNS/);
    assert.match(own.out, /waiting\s+orchard\.example\.com/);
    assert.ok(!/Check again/.test(own.out));

    const refuse = (setup: string, pattern: RegExp) => {
      const failed = flow([], `${FRESH_NET} ASSUME_YES=true; ${setup}`, '', box);
      assert.notEqual(failed.status, 0, failed.out);
      assert.match(failed.out, pattern);
    };
    refuse('parse_args --mode tunnel --domain o.example.com', /--tunnel-token/);
    refuse(
      `parse_args --mode tunnel --tunnel-token ${CF_TOKEN}`,
      /tunnel mode needs a domain: pass --domain/
    );
    refuse('PUBLIC_IP= ; parse_args --mode public', /pass --domain or --public-ip/);
    refuse('parse_args --mode nope', /--mode takes public, tunnel or lan/);
    refuse('parse_args --public-ip nope', /--public-ip takes an IP address or none/);
    refuse('parse_args --email me@example.com', /--email: Let's Encrypt refuses/);
    refuse('parse_args --mcp maybe', /--mcp takes true or false/);
    refuse('parse_args --updates sometimes', /--updates takes manual or automatic/);
    refuse('parse_args --limits maybe', /--limits takes on or off/);
    refuse('parse_args --domain bad_name', /--domain takes a name/);
    refuse('parse_args --domain o.example.com --mcp-domain o.example.com', /can't share/);

    const none = flow(
      [],
      `${FRESH_NET} ASSUME_YES=true; parse_args --public-ip none --ingress-cname none --domain o.example.com --email none`,
      '',
      box
    );
    assert.equal(none.status, 0, none.out);
    assert.match(none.out, /ip= ui=o\.example\.com/);
    assert.match(none.out, /cname= mcp/);
  } finally {
    box.cleanup();
  }
});

test('flags skip their questions and still show on the review screen', () => {
  const { status, out, box } = flow(
    ['', '', '', '', '', '2'],
    `${FRESH_NET}; parse_args --mode public --domain orchard.example.com --public-ip 198.51.100.20 --app-domain a.example.com --mcp false --updates manual`
  );
  try {
    assert.equal(status, 0, out);
    assert.ok(!/How should traffic reach/.test(out));
    assert.ok(!/Dashboard domain/.test(out));
    assert.match(out, /Dashboard\s+https:\/\/orchard\.example\.com/);
    assert.match(out, /Public IP\s+198\.51\.100\.20/);
    assert.match(out, /Apps\s+\*\.a\.example\.com/);
  } finally {
    box.cleanup();
  }
});

test(
  'a re-run goes straight to the review with current values, and --yes keeps them',
  { skip: !has('yq', '--version') },
  () => {
    const box = dnsBox('');
    try {
      const values = join(box.state, 'values.yaml');
      box.run(`mkdir -p "${box.state}"
        ORCHARD_MCP_DOMAIN=agents.other.dev ORCHARD_APP_DOMAIN=kept.example.com
        write_values`);
      writeFileSync(
        join(box.dir, 'kubectl'),
        `#!/bin/sh
case "$*" in
  *clusterissuer*) printf 'me@real.dev' ;;
  *install-settings.js\\ show*) printf 'publicIp=198.51.100.20\\ncname=edge.example.com\\n' ;;
esac
exit 0
`
      );
      const before = readFileSync(values, 'utf8');

      const interactive = flow([''], FRESH_NET, '', box);
      assert.equal(interactive.status, 0, interactive.out);
      assert.match(interactive.out, /already installed here/);
      assert.ok(!/How should traffic reach/.test(interactive.out));
      assert.match(
        interactive.out,
        /RESULT mode=public ip=198\.51\.100\.20 ui=orchard\.example\.com apps=kept\.example\.com cname=edge\.example\.com mcp=true host=agents\.other\.dev email=me@real\.dev/
      );
      assert.ok(!/What changes on this machine/.test(interactive.out));
      assert.ok(!/Create these DNS records/.test(interactive.out));
      assert.equal(readFileSync(values, 'utf8'), before);

      const yes = flow([], `${FRESH_NET} ASSUME_YES=true`, '', box);
      assert.equal(yes.status, 0, yes.out);
      assert.match(
        yes.out,
        /ip=198\.51\.100\.20 ui=orchard\.example\.com apps=kept\.example\.com cname=edge\.example\.com/
      );
      assert.ok(!/What changes/.test(yes.out));
    } finally {
      box.cleanup();
    }
  }
);

test('a changed answer on a re-run says what it affects', { skip: !has('yq', '--version') }, () => {
  const box = dnsBox('');
  try {
    box.run(`mkdir -p "${box.state}"; write_values`);
    writeFileSync(
      join(box.dir, 'kubectl'),
      `#!/bin/sh
case "$*" in
  *install-settings.js\\ show*) printf 'publicIp=198.51.100.20\\ncname=orchard.example.com\\n' ;;
esac
exit 0
`
    );
    const out = flow(
      [],
      `${FRESH_NET} ASSUME_YES=true; parse_args --domain new.example.com --app-domain apps.new.example.com --mcp false --public-ip 198.51.100.21 --ingress-cname edge.example.com`,
      '',
      box
    );
    assert.equal(out.status, 0, out.out);
    assert.match(out.out, /What changes on this machine/);
    assert.match(out.out, /Dashboard moves from orchard\.example\.com to new\.example\.com/);
    assert.match(out.out, /Passkeys belong to the old name/);
    assert.match(out.out, /GitHub App and any SSO provider/);
    assert.match(out.out, /Only new apps use it/);
    assert.match(out.out, /keep their URLs, also after a redeploy/);
    assert.match(out.out, /MCP endpoint turns off/);
    assert.match(out.out, /Custom domains target is now edge\.example\.com/);
    assert.match(out.out, /stay on the\s+.*old address/s);
    assert.match(out.out, /A\s+new\.example\.com/, 'a changed domain lists the records again');
  } finally {
    box.cleanup();
  }
});
