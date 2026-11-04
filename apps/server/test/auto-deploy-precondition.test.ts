import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubService } from '../src/github/github.service';

function messageFor(slug: string | null, owner: string, repo: string): string {
  const service = Object.create(GitHubService.prototype) as GitHubService;
  (service as any).appConfig = { get: () => ({ slug }) };
  return service.autoDeployUnavailableMessage(owner, repo);
}

// Five pushes produced nothing and the only visible state was queuedCommitSha
// staying null. The message has to name both the cause and the fix.
test('the message names the repository and where to install', () => {
  const message = messageFor('orchard', 'LeafdTK', 'pomona');
  assert.match(message, /LeafdTK\/pomona/);
  assert.match(message, /https:\/\/github\.com\/apps\/orchard\/installations\/new/);
});

// The case that actually bit: the App was installed on the account, but with
// "only select repositories", and the repo was created after the install.
test('the message calls out select-repositories installs specifically', () => {
  const message = messageFor('orchard', 'LeafdTK', 'pomona');
  assert.match(message, /only select repositories/);
  assert.match(message, /isn't added to it automatically/);
});

test('it says what still works, so nobody thinks the deployment is dead', () => {
  assert.match(messageFor('orchard', 'o', 'r'), /Manual builds and rebuilds work/);
});

// An instance with no App configured cannot produce an install URL, and must
// still explain itself rather than throwing while explaining.
test('an unconfigured app still produces a usable message', () => {
  const message = messageFor(null, 'o', 'r');
  assert.match(message, /GitHub App settings/);
  assert.match(message, /auto-deploy can't be enabled/);
});
