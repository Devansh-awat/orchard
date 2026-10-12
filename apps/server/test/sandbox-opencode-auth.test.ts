import test from 'node:test';
import assert from 'node:assert/strict';
import { SANDBOX_BOOTSTRAP_SCRIPT } from '../src/sandboxes/sandbox-bootstrap';
import { opencodeAuthJson } from '../src/sandboxes/runners/sandbox-init-files';

test('the anthropic auth plugin sees a refreshable oauth credential, or it fails closed', () => {
  const auth = JSON.parse(opencodeAuthJson('sk-ant-oat01-example')).anthropic;
  assert.equal(auth.type, 'oauth');
  assert.equal(auth.access, 'sk-ant-oat01-example');
  assert.ok(auth.refresh.length > 0);
  assert.ok(auth.expires > Date.now() + 100 * 365 * 24 * 3_600_000);
});

test('no claude token writes no anthropic credential', () => {
  assert.deepEqual(JSON.parse(opencodeAuthJson(null)), {});
});

test('boot leaves the anthropic auth plugin a sidecar config, or it stays dark', () => {
  assert.match(
    SANDBOX_BOOTSTRAP_SCRIPT,
    /\[ -e \/persist\/home\/\.config\/opencode\/anthropic-auth\.json \] \|\| echo '\{\}' > \/persist\/home\/\.config\/opencode\/anthropic-auth\.json/
  );
});
