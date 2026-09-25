import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBitbucketPush, parseGithubStylePush, parseGitlabPush } from '../src/git/parse-push';
import { providerFor } from '../src/git/providers';
import type { ConnectionConfig } from '../src/git/git-provider';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const github = {
  ref: 'refs/heads/main',
  before: '1111111111111111111111111111111111111111',
  after: SHA,
  repository: {
    id: 42,
    full_name: 'hackclub/orchard',
    html_url: 'https://github.com/hackclub/orchard'
  },
  pusher: { name: 'leafd' },
  head_commit: {
    id: SHA,
    message: 'feat: thing\n\nbody',
    author: { name: 'Leaf', username: 'leafd' },
    added: ['a.ts'],
    modified: [],
    removed: []
  },
  commits: [{ added: ['a.ts'], modified: ['b.ts'], removed: [] }]
};

const gitea = {
  ...github,
  repository: {
    id: 7,
    full_name: 'team/app',
    html_url: 'https://codeberg.org/team/app',
    clone_url: 'https://codeberg.org/team/app.git'
  },
  pusher: { login: 'leafd', full_name: 'Leaf' }
};

const gitlab = {
  object_kind: 'push',
  ref: 'refs/heads/main',
  before: '1111111111111111111111111111111111111111',
  after: SHA,
  checkout_sha: SHA,
  user_name: 'Leaf',
  user_username: 'leafd',
  project: {
    id: 99,
    path_with_namespace: 'group/sub/app',
    web_url: 'https://gitlab.com/group/sub/app'
  },
  commits: [
    {
      id: SHA,
      message: 'feat: thing',
      author: { name: 'Leaf' },
      added: ['a.ts'],
      modified: [],
      removed: ['z.ts']
    }
  ]
};

const bitbucket = {
  actor: { nickname: 'leafd' },
  repository: {
    uuid: '{2f3a}',
    full_name: 'ws/app',
    links: { html: { href: 'https://bitbucket.org/ws/app' } }
  },
  push: {
    changes: [
      {
        new: {
          type: 'branch',
          name: 'main',
          target: {
            hash: SHA,
            message: 'feat: thing',
            author: { raw: 'Leaf <leaf@example.com>', user: { nickname: 'leafd' } }
          }
        },
        old: {
          type: 'branch',
          name: 'main',
          target: { hash: '1111111111111111111111111111111111111111' }
        },
        closed: false
      }
    ]
  }
};

test('four forges adapt to one push shape', () => {
  const shapes = [
    parseGithubStylePush(github),
    parseGithubStylePush(gitea),
    parseGitlabPush(gitlab),
    parseBitbucketPush(bitbucket)
  ];
  for (const p of shapes) {
    assert.ok(p);
    assert.equal(p.branch, 'main');
    assert.equal(p.commitSha, SHA);
    assert.equal(p.message, 'feat: thing');
    assert.equal(p.authorUsername, 'leafd');
    assert.equal(p.deleted, false);
  }
  assert.deepEqual(
    shapes.map((p) => p!.repoFullName),
    ['hackclub/orchard', 'team/app', 'group/sub/app', 'ws/app']
  );
  assert.deepEqual(
    shapes.map((p) => p!.externalRepoId),
    ['42', '7', '99', '{2f3a}']
  );
  assert.deepEqual(
    shapes.map((p) => p!.repoUrl),
    [
      'https://github.com/hackclub/orchard',
      'https://codeberg.org/team/app',
      'https://gitlab.com/group/sub/app',
      'https://bitbucket.org/ws/app'
    ]
  );
  assert.deepEqual(shapes[0]!.changedFiles, ['a.ts', 'b.ts']);
  assert.deepEqual(shapes[2]!.changedFiles, ['a.ts', 'z.ts']);
  assert.equal(shapes[3]!.changedFiles, null);
});

test('a deleted branch is not a push to build', () => {
  const gone = parseGithubStylePush({
    ...github,
    after: '0000000000000000000000000000000000000000',
    deleted: true,
    head_commit: null
  });
  assert.ok(gone);
  assert.equal(gone.deleted, true);
  assert.equal(gone.commitSha, null);
  const gl = parseGitlabPush({
    ...gitlab,
    after: '0000000000000000000000000000000000000000',
    checkout_sha: null,
    commits: []
  });
  assert.equal(gl!.deleted, true);
  const bb = parseBitbucketPush({
    ...bitbucket,
    push: { changes: [{ ...bitbucket.push.changes[0], new: null, closed: true }] }
  });
  assert.equal(bb!.deleted, true);
});

test('tags and non-push events are ignored', () => {
  assert.equal(parseGithubStylePush({ ...github, ref: 'refs/tags/v1' }), null);
  assert.equal(parseGitlabPush({ ...gitlab, object_kind: 'tag_push', ref: 'refs/tags/v1' }), null);
  const config: ConnectionConfig = {
    kind: 'gitlab',
    baseUrl: 'https://gitlab.com',
    username: null,
    token: 't',
    webhookSecret: 's'
  };
  assert.equal(
    providerFor(config).parsePush({ 'x-gitlab-event': 'Merge Request Hook' }, gitlab),
    null
  );
  const gh: ConnectionConfig = { ...config, kind: 'github', baseUrl: 'https://github.com' };
  assert.equal(providerFor(gh).parsePush({ 'x-github-event': 'ping' }, github), null);
  assert.ok(providerFor(gh).parsePush({ 'x-github-event': 'push' }, github));
});
