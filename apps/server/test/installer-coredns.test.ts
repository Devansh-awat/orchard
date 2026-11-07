import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const installer = resolve(__dirname, '../../../install/install.sh');

function run(script: string) {
  return spawnSync(
    'bash',
    [
      '-c',
      `export ORCHARD_LIB_ONLY=1 NO_COLOR=1 ORCHARD_NO_PACING=1\nsource "${installer}"\nset +e\n${script}`
    ],
    { encoding: 'utf8', env: { ...process.env, KUBECONFIG: '/dev/null' } }
  );
}

test('the installer ships a CoreDNS override that blocks PTR lookups from pods', () => {
  const out = run('coredns_custom_manifest');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /name: coredns-custom/);
  assert.match(out.stdout, /namespace: kube-system/);
  assert.match(out.stdout, /orchard-reverse-dns\.override: \|/);
  assert.match(out.stdout, /acl in-addr\.arpa ip6\.arpa \{\n\s+block type PTR\n\s+\}/);
});

test('harden_coredns applies the manifest and restarts CoreDNS when present', () => {
  const out = run(
    `kubectl() { if [ "$1" = apply ]; then echo "APPLIED:$(cat | grep -c 'block type PTR')"; else echo "KUBECTL:$*"; fi; }\nharden_coredns`
  );
  assert.match(out.stdout, /APPLIED:1/);
  assert.match(out.stdout, /rollout restart deploy\/coredns/);
});
