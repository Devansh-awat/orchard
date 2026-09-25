import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeCloneCredential,
  encodeCloneCredential,
  redactUrlUserinfo
} from '../src/git/clone-credential';

test('userinfo is redacted from any https url, whatever the token looks like', () => {
  const lines = [
    "fatal: unable to access 'https://x-access-token:ghs_abc123@github.com/o/r.git/'",
    'Cloning https://oauth2:glpat-XYZ@gitlab.com/g/p.git',
    'remote: https://git:s3cret@git.example.internal:8443/team/repo',
    'https://user:p%40ss@bitbucket.org/ws/app'
  ];
  for (const line of lines) {
    const out = redactUrlUserinfo(line);
    assert.ok(!/ghs_|glpat|s3cret|p%40ss/.test(out), out);
    assert.ok(out.includes('https://***@'), out);
  }
  assert.equal(
    redactUrlUserinfo('https://github.com/o/r no creds here'),
    'https://github.com/o/r no creds here'
  );
});

test('a clone credential round-trips and keeps its host', () => {
  const token = encodeCloneCredential({ host: 'Codeberg.org', username: 'git', password: 'a:b:c' });
  assert.deepEqual(decodeCloneCredential(token), {
    host: 'codeberg.org',
    username: 'git',
    password: 'a:b:c'
  });
  assert.equal(decodeCloneCredential('ghs_plain'), null);
  assert.equal(decodeCloneCredential(undefined), null);
});
