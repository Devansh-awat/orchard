import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_TOWNS,
  chatTitleFor,
  isAgentTitle,
  isGeneratedSessionName,
  pickSessionName,
  promptTitle
} from '../server/src/sandboxes/session-names';

test('session names are Vermont towns nobody on the machine is using yet', () => {
  const taken = SESSION_TOWNS.slice(1);
  assert.equal(pickSessionName(taken), SESSION_TOWNS[0]);
  assert.equal(
    pickSessionName(['burlington'], () => 0),
    SESSION_TOWNS[1]
  );
  assert.ok(SESSION_TOWNS.includes(pickSessionName([]) as (typeof SESSION_TOWNS)[number]));
});

test('once every city is taken the names get numbered instead of repeating', () => {
  const all = [...SESSION_TOWNS];
  assert.equal(
    pickSessionName(all, () => 0),
    `${SESSION_TOWNS[0]} 2`
  );
  assert.equal(
    pickSessionName([...all, `${SESSION_TOWNS[0]} 2`], () => 0),
    `${SESSION_TOWNS[0]} 3`
  );
});

test('the city list has no duplicates', () => {
  const lower = SESSION_TOWNS.map((c) => c.toLowerCase());
  assert.equal(new Set(lower).size, lower.length);
});

test('generated names are recognised so empty sessions are not offered as context', () => {
  assert.ok(isGeneratedSessionName('Burlington'));
  assert.ok(isGeneratedSessionName('st. albans 3'));
  assert.equal(isGeneratedSessionName('Fix the login form'), false);
});

test('a prompt becomes a short title from its first sentence', () => {
  assert.equal(promptTitle('fix the login form. it breaks on safari'), 'Fix the login form');
  assert.equal(
    promptTitle('## Add **dark mode** to the [settings](http://x) page'),
    'Add dark mode to the settings page'
  );
  assert.equal(promptTitle('```ts\nconst x = 1\n```\nwhy does this crash?'), 'Why does this crash');
  assert.equal(promptTitle('- refactor the sidebar\n- and the dock'), 'Refactor the sidebar');
  const long = promptTitle(
    'make the session sidebar group repositories by their owner and sort the sessions by the most recent activity'
  );
  assert.ok(long && long.length <= 60 && long.endsWith('…'), long ?? '');
  assert.equal(promptTitle('ok'), null);
  assert.equal(promptTitle('   \n  '), null);
});

test('agent titles are used unless they are the agent default', () => {
  assert.ok(isAgentTitle('Fix Safari login bug'));
  assert.equal(isAgentTitle('New session - 2026-10-16T02:41:00.000Z'), false);
  assert.equal(isAgentTitle('Child session'), false);
  assert.equal(isAgentTitle(''), false);
  assert.equal(isAgentTitle(null), false);
  assert.equal(isAgentTitle('Burlington'), false);
});

test('chats for a city-named session are created untitled so the agent can name them', () => {
  assert.deepEqual(chatTitleFor('Burlington'), {});
  assert.deepEqual(chatTitleFor('Fix login'), { title: 'Fix login' });
});
