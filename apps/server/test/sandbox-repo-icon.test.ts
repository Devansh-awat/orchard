import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import {
  REPO_ICON_LUCIDE,
  isRepoEmoji,
  isRepoIcon,
  normalizeRepoIcon,
  storedRepoIcon
} from '../src/sandboxes/sandbox-repo-icon';
import { githubRepoOf } from '../src/sandboxes/sandbox-repo-url';
import { parseRepoListing } from '../src/sandboxes/sandbox-workspace.service';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

test('a single emoji grapheme is a repo icon', () => {
  for (const emoji of ['🚀', '🌱', '❤️', '👍🏽', '🏳️‍🌈', '🇳🇱', '🧑‍💻']) {
    assert.ok(isRepoEmoji(emoji), emoji);
    assert.equal(normalizeRepoIcon(emoji), emoji);
  }
});

test('anything that is not exactly one emoji is refused', () => {
  for (const bad of ['', 'a', 'ab', '🚀🚀', '🚀 ', ' ', '1', '#', '©x', '🚀\n', '\u0007', '👨‍👩‍👧‍👦']) {
    assert.equal(isRepoEmoji(bad), false, JSON.stringify(bad));
  }
  assert.throws(() => normalizeRepoIcon('🚀🚀'), BadRequestException);
  assert.throws(() => normalizeRepoIcon("'; rm -rf / #"), BadRequestException);
  assert.throws(() => normalizeRepoIcon('$(id)'), BadRequestException);
  assert.throws(() => normalizeRepoIcon(42), BadRequestException);
  assert.throws(() => normalizeRepoIcon({ icon: '🚀' }), BadRequestException);
});

test('lucide icons come from the allowlist only', () => {
  for (const name of REPO_ICON_LUCIDE) assert.ok(isRepoIcon(`lucide:${name}`), name);
  assert.equal(REPO_ICON_LUCIDE.length, 20);
  for (const bad of ['lucide:', 'lucide:skull', 'lucide:Rocket', 'lucide:rocket ', 'rocket']) {
    assert.equal(isRepoIcon(bad), false, bad);
  }
  assert.equal(normalizeRepoIcon(' lucide:rocket '), 'lucide:rocket');
});

test('github and null are accepted, blank clears', () => {
  assert.equal(normalizeRepoIcon('github'), 'github');
  assert.equal(normalizeRepoIcon(null), null);
  assert.equal(normalizeRepoIcon('  '), null);
  assert.throws(() => normalizeRepoIcon('GitHub'), BadRequestException);
});

test('a hand-edited git config value never reaches the client', () => {
  assert.equal(storedRepoIcon('<img src=x>'), null);
  assert.equal(storedRepoIcon('lucide:rocket\n'), 'lucide:rocket');
  assert.equal(storedRepoIcon(''), null);
  assert.equal(storedRepoIcon(undefined), null);
});

test('github remotes parse from https and ssh forms only', () => {
  const ok = { owner: 'LeafdTK', name: 'orchard-releases' };
  assert.deepEqual(githubRepoOf('https://github.com/LeafdTK/orchard-releases.git'), ok);
  assert.deepEqual(githubRepoOf('https://github.com/LeafdTK/orchard-releases'), ok);
  assert.deepEqual(
    githubRepoOf('https://x-access-token:abc@github.com/LeafdTK/orchard-releases'),
    ok
  );
  assert.deepEqual(githubRepoOf('git@github.com:LeafdTK/orchard-releases.git'), ok);
  assert.deepEqual(githubRepoOf('ssh://git@github.com/LeafdTK/orchard-releases.git'), ok);
  assert.deepEqual(githubRepoOf('https://github.com/acme/site.github.io.git'), {
    owner: 'acme',
    name: 'site.github.io'
  });
  for (const bad of [
    '',
    null,
    'http://github.com/acme/app',
    'https://gitlab.com/acme/app',
    'https://evil.com/github.com/acme/app',
    'https://github.com.evil.com/acme/app',
    'https://github.com/acme/app/tree/main',
    'https://github.com/-acme/app',
    'https://github.com/acme/..',
    'git@gitlab.com:acme/app.git'
  ]) {
    assert.equal(githubRepoOf(bad), null, String(bad));
  }
});

test('repo listing decodes every field, whatever characters they hold', () => {
  const stdout = [
    `${b64('orchard')}|${b64('main')}|3|${b64('https://github.com/LeafdTK/orchard.git')}|${b64('🌱')}`,
    `${b64('a|b')}|${b64('feat/x|y')}|0|${b64('')}|${b64('lucide:rocket')}`,
    `${b64('local')}||12||`,
    `${b64('junk')}|${b64('main')}|1|${b64('git@github.com:acme/junk')}|${b64('not an icon')}`,
    'orchard|main|3',
    `${b64('../etc')}|x|1||`,
    `!!!|${b64('main')}|0||`,
    ''
  ].join('\n');
  assert.deepEqual(parseRepoListing(stdout), [
    {
      name: 'orchard',
      branch: 'main',
      dirtyFiles: 3,
      github: { owner: 'LeafdTK', name: 'orchard' },
      icon: '🌱'
    },
    { name: 'a|b', branch: 'feat/x|y', dirtyFiles: 0, github: null, icon: 'lucide:rocket' },
    { name: 'local', branch: null, dirtyFiles: 12, github: null, icon: null },
    {
      name: 'junk',
      branch: 'main',
      dirtyFiles: 1,
      github: { owner: 'acme', name: 'junk' },
      icon: null
    }
  ]);
});
