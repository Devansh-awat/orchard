import test from 'node:test';
import assert from 'node:assert/strict';
import { alertCopy, firstLine } from './agent-alerts';

test('the body is the first readable line of the answer', () => {
  assert.equal(firstLine('## Done\n\nAll tests pass.'), 'Done');
  assert.equal(firstLine('\n\n**Fixed** the `login` bug.\nMore detail'), 'Fixed the login bug.');
  assert.equal(firstLine('```ts\nconst x = 1;\n```\nShipped it.'), 'Shipped it.');
  assert.equal(firstLine('- first item\n- second'), 'first item');
  assert.equal(firstLine(null), '');
  assert.equal(firstLine('x'.repeat(200)).length, 140);
});

test('titles name the session and the kind of event', () => {
  assert.deepEqual(alertCopy('done', 'Fix login', 'All green.', false), {
    title: 'Fix login finished',
    body: 'All green.'
  });
  assert.equal(alertCopy('attention', '', null, false).title, 'Your session needs you');
  assert.equal(alertCopy('attention', 'X', null, false).body, 'The agent is waiting for an answer');
  assert.equal(alertCopy('error', 'X', 'Rate limited\nretry later', false).body, 'Rate limited');
});

test('the not absolutely right preference also tidies the notification', () => {
  assert.equal(
    alertCopy('done', 'X', "You're absolutely right! The cache was stale.", true).body,
    'The cache was stale.'
  );
  assert.equal(
    alertCopy('done', 'X', "You're absolutely right! The cache was stale.", false).body,
    "You're absolutely right! The cache was stale."
  );
});
