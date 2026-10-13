import test from 'node:test';
import assert from 'node:assert/strict';
import { inWorktree } from './worktree-dir';

const worktree = '/persist/home/.worktrees/orchard-releases/hi-67b406';

test('a chat matches its worktree by the logical path', () => {
  assert.equal(inWorktree(worktree, worktree), true);
});

test('a chat matches when the agent stored the resolved home path', () => {
  assert.equal(
    inWorktree('/vercel/sandbox/orchard/home/.worktrees/orchard-releases/hi-67b406', worktree),
    true
  );
});

test('other worktrees and the bare home never match', () => {
  assert.equal(inWorktree('/persist/home/.worktrees/orchard-releases/hi-other', worktree), false);
  assert.equal(inWorktree('/vercel/sandbox/orchard/home/.worktrees/x/hi-67b406', worktree), false);
  assert.equal(inWorktree('/vercel/sandbox/orchard/home', worktree), false);
  assert.equal(inWorktree(null, worktree), false);
  assert.equal(inWorktree('/persist/home/x', '/srv/app'), false);
});
