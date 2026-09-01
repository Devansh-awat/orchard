import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoUrl, withGitHubCredentials } from '../src/docker/repo-url';

const REJECTED = [
  'https://github.com/o/r" ; id ; echo "',
  'https://github.com/o/r$(id)',
  "https://github.com/o/r' ; id ; echo '",
  'https://github.com/o/r;id',
  'https://github.com/o/r|id',
  'https://github.com/o/r&id',
  'ext::sh -c whoami',
  'file:///etc/passwd',
  'git://github.com/o/r',
  'ssh://git@github.com/o/r',
  'http://github.com/o/r',
  'https://user:pass@github.com/o/r',
  'not a url',
  '',
  '-upload-pack=id',
];

for (const bad of REJECTED) {
  test(`parseRepoUrl rejects ${JSON.stringify(bad)}`, () => {
    assert.equal(parseRepoUrl(bad), null);
  });
}

const ACCEPTED = [
  'https://github.com/hackclub/orchard',
  'https://github.com/hackclub/orchard.git',
  'https://gitlab.com/group/sub/project',
  'https://git.example.internal:8443/team/repo',
  'https://codeberg.org/some-user/some_repo',
];

test('parseRepoUrl accepts ordinary https repos, including self-hosted', () => {
  for (const ok of ACCEPTED) assert.ok(parseRepoUrl(ok), `${ok} should parse`);
});

test('anything parseRepoUrl accepts is free of shell metacharacters', () => {
  for (const ok of ACCEPTED) {
    const { href } = parseRepoUrl(ok)!;
    assert.doesNotMatch(href, /[$'"`;&|<>(){}\\\s]/, `${href} carries a shell metacharacter`);
  }
});

test('metacharacters URL parsing escapes for us come back inert', () => {
  for (const s of ['https://github.com/o/r>out', 'https://github.com/o/r`id`']) {
    const url = parseRepoUrl(s);
    assert.ok(url, `${s} should parse`);
    assert.doesNotMatch(url!.href, /[>`]/);
  }
});

test('the GitHub token is attached only when the host really is github.com', () => {
  const token = 'ghs_secret';

  const real = parseRepoUrl('https://github.com/o/r')!;
  assert.equal(withGitHubCredentials(real, token), `https://x-access-token:${token}@github.com/o/r`);
  for (const impostor of ['https://github.com.evil.com/o/r', 'https://evil.com/github.com/o/r']) {
    const url = parseRepoUrl(impostor)!;
    const out = withGitHubCredentials(url, token);
    assert.ok(!out.includes(token), `token leaked into ${impostor} -> ${out}`);
    assert.equal(out, url.href);
  }
  assert.equal(parseRepoUrl('https://evil.com/?x=https://github.com/o/r'), null);
});

test('a user OAuth token uses the bare-credential form', () => {
  const url = parseRepoUrl('https://github.com/o/r')!;
  assert.equal(withGitHubCredentials(url, 'gho_x'), 'https://gho_x@github.com/o/r');
});

test('no token means the URL is passed through untouched', () => {
  const url = parseRepoUrl('https://github.com/o/r')!;
  assert.equal(withGitHubCredentials(url, undefined), 'https://github.com/o/r');
});
