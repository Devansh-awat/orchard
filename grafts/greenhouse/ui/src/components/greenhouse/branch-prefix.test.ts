import test from 'node:test';
import assert from 'node:assert/strict';
import { branchPrefixFor, cleanBranchPrefix } from './branch-prefix';

const SERVER_RULE = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)?$/;

function valid(prefix: string): boolean {
  return (
    prefix.length <= 40 &&
    SERVER_RULE.test(prefix) &&
    !prefix.includes('..') &&
    !prefix.endsWith('.') &&
    !prefix.startsWith('-') &&
    !prefix.split('/').some((p) => p.endsWith('.lock'))
  );
}

test('custom prefixes are cleaned into something the server accepts', () => {
  assert.equal(cleanBranchPrefix('seb'), 'seb');
  assert.equal(cleanBranchPrefix(' seb/wip '), 'seb/wip');
  assert.equal(cleanBranchPrefix('/seb//wip/'), 'seb/wip');
  assert.equal(cleanBranchPrefix('my branch'), 'my-branch');
  assert.equal(cleanBranchPrefix('a..b'), 'a.b');
  assert.equal(cleanBranchPrefix('.hidden/x.lock'), 'hidden/x');
  assert.equal(cleanBranchPrefix("$(id);'rm'"), 'id-rm-');
  assert.equal(cleanBranchPrefix('feat@{1}'), 'feat-1-');
  assert.equal(cleanBranchPrefix('end.'), 'end');
  assert.equal(cleanBranchPrefix(''), '');
  for (const raw of [
    'x'.repeat(60),
    'a/'.repeat(30),
    '-lead',
    'ok/.../x',
    'weird~^:?*[\\',
    'déjà vu',
    'trail.lock.lock',
    `${'y'.repeat(39)}..z`
  ]) {
    const out = cleanBranchPrefix(raw);
    assert.ok(valid(out), `${raw} -> ${out}`);
  }
});

test('the mode picks the prefix and falls back to orchard', () => {
  assert.equal(branchPrefixFor('orchard', 'ignored', 'leafd'), 'orchard');
  assert.equal(branchPrefixFor('github', '', 'Leafd'), 'Leafd');
  assert.equal(branchPrefixFor('github', '', null), 'orchard');
  assert.equal(branchPrefixFor('custom', 'seb/wip', null), 'seb/wip');
  assert.equal(branchPrefixFor('custom', '///', null), 'orchard');
  assert.equal(branchPrefixFor('none', 'seb', 'leafd'), '');
});
