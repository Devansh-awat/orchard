import test from 'node:test';
import assert from 'node:assert/strict';

import { autoDeployMatchesBranch, autoDeployTargetBranch } from '../src/github/auto-deploy-match';

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
    [pinned, inherited],
  );
  assert.deepEqual(
    repo.filter((deployment) => autoDeployMatchesBranch(deployment, 'staging')),
    [otherBranch],
  );
});
