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
        KUBECONFIG: '/dev/null',
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
        `${clean}; load_previous_answers; collect_domains() { :; }; INGRESS_EXTRA_HOSTS='["mango", "mango.tail.ts.net"]'; write_values`
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

test('derives the app and MCP domains without asking', () => {
  const box = sandbox();
  try {
    const collect = (domain: string, extra = '') =>
      box.run(`
        ASSUME_YES=true INGRESS_MODE=public PUBLIC_IP=203.0.113.10
        ORCHARD_DOMAIN=${domain} ORCHARD_APP_DOMAIN= ORCHARD_MCP_DOMAIN=
        ${extra}
        collect_domains
        printf 'apps=%s mcp=%s\\n' "$ORCHARD_APP_DOMAIN" "$ORCHARD_MCP_DOMAIN"
      `);
    const first = collect('orchard.example.com');
    assert.match(first, /apps=apps\.example\.com mcp=mcp\.apps\.example\.com/);
    assert.match(first, /A {2}\*\.apps\.example\.com/);
    assert.ok(!/A {2}mcp\./.test(first), 'the wildcard already covers the MCP');

    assert.match(collect('example.com'), /apps=apps\.example\.com/);
    assert.match(collect('example.co.uk'), /apps=apps\.example\.co\.uk/);
    assert.match(collect('orchard.example.co.uk'), /apps=apps\.example\.co\.uk/);

    const moved = collect('orchard.example.com', 'ORCHARD_MCP_DOMAIN=agents.other.dev');
    assert.match(
      moved,
      /A {2}agents\.other\.dev/,
      'a name outside the wildcard needs its own record'
    );

    const nested = collect('orchard.example.com', 'ORCHARD_MCP_DOMAIN=a.b.apps.example.com');
    assert.match(nested, /A {2}a\.b\.apps\.example\.com/, 'a wildcard covers one label only');

    const off = collect('orchard.example.com', 'ORCHARD_MCP=false');
    assert.ok(
      !/mcp\.apps/.test(
        off
          .split('\n')
          .filter((l) => l.includes(' A '))
          .join()
      )
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
  'the CNAME target for custom domains is written on a new install only',
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
      const fresh = (setup: string) => {
        rmSync(box.state, { recursive: true, force: true });
        box.run(`mkdir -p "${box.state}"; ${setup}; write_values`);
        return cname();
      };

      assert.equal(fresh('INGRESS_MODE=public'), 'orchard.example.com');

      const token = Buffer.from(
        JSON.stringify({ a: 'acct', t: '8a1b2c3d-0000-4000-8000-000000000001', s: 'c2VjcmV0' })
      ).toString('base64');
      assert.equal(
        fresh(`USE_TLS=false CERT_ISSUER= INGRESS_MODE=tunnel ORCHARD_TUNNEL_TOKEN=${token}`),
        '8a1b2c3d-0000-4000-8000-000000000001.cfargotunnel.com'
      );
      assert.equal(
        fresh('USE_TLS=false CERT_ISSUER= INGRESS_MODE=tunnel ORCHARD_TUNNEL_TOKEN=not-a-token'),
        ''
      );
      assert.equal(
        fresh('USE_TLS=false CERT_ISSUER=selfsigned INGRESS_MODE=lan PRIMARY_IP=192.168.1.5'),
        'orchard.192-168-1-5.sslip.io'
      );

      fresh('INGRESS_MODE=public');
      execFileSync('yq', ['-i', 'del(.server.env[] | select(.name == "INGRESS_CNAME"))', values]);
      box.run('load_previous_answers; write_values');
      assert.equal(cname(), '', 'an existing install does not gain a pinned value');

      fresh('INGRESS_MODE=public');
      execFileSync('yq', [
        '-i',
        '(.server.env[] | select(.name == "INGRESS_CNAME") | .value) = "edge.example.com"',
        values
      ]);
      box.run('load_previous_answers; ORCHARD_DOMAIN=other.example.com; write_values');
      assert.equal(cname(), 'edge.example.com', 'one the operator chose is left alone');
    } finally {
      box.cleanup();
    }
  }
);

test('the public IP is saved once, on a new public install with a routable address', () => {
  const box = sandbox();
  try {
    const seed = (setup: string) => {
      const log = join(box.dir, 'restarts');
      rmSync(log, { force: true });
      box.run(
        `mkdir -p "${box.state}"; PUBLIC_IP=203.0.113.10 BEHIND_NAT=false; ${setup}; seed_public_ip`
      );
      return existsSync(log) ? readFileSync(log, 'utf8') : '';
    };
    const pending = join(box.state, 'public-ip-pending');
    const arm = 'touch "$STATE_DIR/public-ip-pending"';

    assert.equal(seed(':'), '', 'a re-run has nothing pending');
    assert.match(seed(arm), /seed-public-ip\.js 203\.0\.113\.10/);
    assert.ok(!existsSync(pending));

    assert.equal(seed(`${arm}; BEHIND_NAT=true`), '');
    assert.ok(!existsSync(pending));
    assert.equal(seed(`${arm}; INGRESS_MODE=tunnel`), '');
    assert.equal(seed(`${arm}; INGRESS_MODE=lan`), '');

    writeFileSync(join(box.dir, 'kubectl'), '#!/bin/sh\nexit 1\n');
    const failed = box.run(
      `mkdir -p "${box.state}"; PUBLIC_IP=203.0.113.10 BEHIND_NAT=false; ${arm}; seed_public_ip`
    );
    assert.match(failed, /admin panel/);
    assert.ok(existsSync(pending), 'a failure stays pending for the next run');
  } finally {
    box.cleanup();
  }
});

test('a public install with no domain falls back to sslip.io', () => {
  const box = sandbox();
  try {
    const out = box.run(`
      ASSUME_YES=true INGRESS_MODE=public PUBLIC_IP=203.0.113.10 BEHIND_NAT=false
      ORCHARD_DOMAIN= ORCHARD_APP_DOMAIN= ORCHARD_MCP_DOMAIN=
      collect_domains
      printf 'ui=%s apps=%s mcp=%s\\n' "$ORCHARD_DOMAIN" "$ORCHARD_APP_DOMAIN" "$ORCHARD_MCP_DOMAIN"
    `);
    assert.match(
      out,
      /ui=orchard\.203-0-113-10\.sslip\.io apps=apps\.203-0-113-10\.sslip\.io mcp=mcp\.apps\.203-0-113-10\.sslip\.io/
    );
    assert.match(out, /no DNS records to add/);
    assert.ok(!/Point these records/.test(out));
    assert.match(out, /share one Let's Encrypt limit/);

    const refused = spawnSync(
      'bash',
      [
        '-c',
        `${preamble}\nASSUME_YES=true INGRESS_MODE=public PUBLIC_IP= ORCHARD_DOMAIN= ORCHARD_APP_DOMAIN=\ncollect_domains`
      ],
      { encoding: 'utf8' }
    );
    assert.notEqual(refused.status, 0, 'with no public IP there is nothing to derive a name from');
  } finally {
    box.cleanup();
  }
});

test(
  'moving off sslip.io re-derives the app and MCP domains',
  { skip: !has('yq', '--version') },
  () => {
    const box = sandbox();
    try {
      box.run(`mkdir -p "${box.state}"
      ORCHARD_DOMAIN=orchard.203-0-113-10.sslip.io
      ORCHARD_APP_DOMAIN=apps.203-0-113-10.sslip.io
      ORCHARD_MCP_DOMAIN=mcp.apps.203-0-113-10.sslip.io
      write_values`);
      const moved = box.run(`
      ORCHARD_DOMAIN= ORCHARD_APP_DOMAIN= ORCHARD_MCP_DOMAIN= ASSUME_YES=true INGRESS_MODE=public
      parse_args --domain orchard.example.com
      load_previous_answers
      collect_domains
      write_values
      printf 'apps=%s mcp=%s' "$ORCHARD_APP_DOMAIN" "$ORCHARD_MCP_DOMAIN"
    `);
      assert.match(moved, /apps=apps\.example\.com mcp=mcp\.apps\.example\.com/);
      assert.match(moved, /Point these records/);
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
      assert.equal(env('INGRESS_CNAME'), 'orchard.example.com');
    } finally {
      box.cleanup();
    }
  }
);

test('the summary is short, honest about the certificate, and has no em dashes', () => {
  const box = sandbox();
  try {
    writeFileSync(join(box.dir, 'kubectl'), '#!/bin/sh\nprintf False\n');
    const out = box.run(`
      ORCHARD_DOMAIN=orchard.203-0-113-10.sslip.io ORCHARD_UPDATE_POLICY=manual STEP_N=0
      orchard-claim() { return 1; }
      summary
    `);
    assert.match(out, /https:\/\/orchard\.203-0-113-10\.sslip\.io/);
    assert.match(out, /passkey or a password/);
    assert.match(out, /--updates automatic/);
    assert.match(out, /--domain <host>/);
    assert.match(out, /certificate is not ready/);
    assert.ok(
      !/[\u2013\u2014]/.test(readFileSync(installer, 'utf8')),
      'no em dashes in the installer'
    );
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
        ORCHARD_DOMAIN= ORCHARD_APP_DOMAIN= ORCHARD_MCP_DOMAIN= ASSUME_YES=true INGRESS_MODE=public
        load_previous_answers
        collect_domains
      `);
      assert.ok(!/Point these records/.test(out));
    } finally {
      box.cleanup();
    }
  }
);
