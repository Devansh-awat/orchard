import './support';
import test from 'node:test';
import assert from 'node:assert/strict';
import { curlMethodArg } from '../server/src/sandboxes/sandbox-curl-method';

test('allowlisted methods are quoted and upper-cased', () => {
  assert.equal(curlMethodArg('GET'), "-X 'GET'");
  assert.equal(curlMethodArg('patch'), "-X 'PATCH'");
  assert.equal(curlMethodArg('DELETE'), "-X 'DELETE'");
});

test('methods outside the allowlist are refused, including shell metacharacters', () => {
  for (const method of ['`id`', 'GET|id', 'GET;id', '$(id)', 'TRACE', 'CONNECT', '', 'G`id`ET']) {
    assert.equal(curlMethodArg(method), null, method);
  }
  assert.equal(curlMethodArg(undefined as unknown as string), null);
});
