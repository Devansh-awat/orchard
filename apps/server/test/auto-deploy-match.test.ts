import test from 'node:test';
import assert from 'node:assert/strict';

import {
  autoDeployMatchesBranch,
  autoDeployTargetBranch,
  canonicalRepoUrl,
  pushCommitSha,
  repoUrlVariants
} from '../src/github/auto-deploy-match';

const pinned = { autoDeployBranch: 'main', githubBranch: 'main' };
const inherited = { autoDeployBranch: null, githubBranch: 'main' };
const otherBranch = { autoDeployBranch: 'staging', githubBranch: 'main' };
const unlinked = { autoDeployBranch: null, githubBranch: null };

test('a deployment falls back to its github branch when no branch is pinned', () => {
  assert.equal(autoDeployTargetBranch(pinned), 'main');
  assert.equal(autoDeployTargetBranch(inherited), 'main');
  assert.equal(autoDeployTargetBranch(otherBranch), 'staging');
  assert.equal(autoDeployTargetBranch(unlinked), null);
});

test('a push only matches the branch a deployment tracks', () => {
  assert.equal(autoDeployMatchesBranch(pinned, 'main'), true);
  assert.equal(autoDeployMatchesBranch(inherited, 'main'), true);
  assert.equal(autoDeployMatchesBranch(otherBranch, 'main'), false);
  assert.equal(autoDeployMatchesBranch(otherBranch, 'staging'), true);
  assert.equal(autoDeployMatchesBranch(unlinked, 'main'), false);
});

test('a pinned deployment never decides for one that inherits its branch', () => {
  const repo = [pinned, inherited, otherBranch, unlinked];
  assert.deepEqual(
    repo.filter((deployment) => autoDeployMatchesBranch(deployment, 'main')),
    [pinned, inherited]
  );
  assert.deepEqual(
    repo.filter((deployment) => autoDeployMatchesBranch(deployment, 'staging')),
    [otherBranch]
  );
});

const NULL_SHA = '0000000000000000000000000000000000000000';

test('a real push offers its head commit', () => {
  assert.equal(pushCommitSha({ after: 'abc123', head_commit: { id: 'abc123' } }), 'abc123');
  assert.equal(pushCommitSha({ head_commit: { id: 'def456' } }), 'def456');
});

test('deleting a branch offers nothing to deploy', () => {
  // Same event, same ref as any other push to that branch, only `deleted` and
  // the null sha say otherwise, and a build of the null sha can only fail.
  assert.equal(pushCommitSha({ deleted: true, after: NULL_SHA, head_commit: null }), null);
  assert.equal(pushCommitSha({ after: NULL_SHA, head_commit: null }), null);
  assert.equal(pushCommitSha({ head_commit: null }), null);
  assert.equal(pushCommitSha({}), null);
});

test('a deleted flag beats a sha that still looks real', () => {
  assert.equal(pushCommitSha({ deleted: true, after: 'abc123' }), null);
});

test('both stored spellings of a repo url are matched', () => {
  assert.deepEqual(repoUrlVariants('hackclub/orchard'), [
    'https://github.com/hackclub/orchard',
    'https://github.com/hackclub/orchard.git'
  ]);
});

test('rewriting a url keeps the suffix convention the row already had', () => {
  assert.equal(
    canonicalRepoUrl('https://github.com/hackclub/old', 'hackclub/new'),
    'https://github.com/hackclub/new'
  );
  assert.equal(
    canonicalRepoUrl('https://github.com/hackclub/old.git', 'hackclub/new'),
    'https://github.com/hackclub/new.git'
  );
  assert.equal(canonicalRepoUrl(null, 'hackclub/new'), 'https://github.com/hackclub/new');
});
