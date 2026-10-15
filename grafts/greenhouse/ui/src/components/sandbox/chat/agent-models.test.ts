import test from 'node:test';
import assert from 'node:assert/strict';
import { agentChoiceGroups } from './agent-models';

test('drops a provider prefix that just repeats the agent and pulls out Free', () => {
  const groups = agentChoiceGroups(
    [
      { value: 'a', name: 'OpenCode/Muse Spark 1.3 Free' },
      { value: 'b', name: 'OpenCode/Step 5 Preview' }
    ],
    'opencode'
  );
  assert.deepEqual(groups, [
    {
      name: '',
      items: [
        { value: 'a', name: 'OpenCode/Muse Spark 1.3 Free', label: 'Muse Spark 1.3', free: true },
        { value: 'b', name: 'OpenCode/Step 5 Preview', label: 'Step 5 Preview', free: false }
      ]
    }
  ]);
});

test('keeps real providers as sections in the order they first appear', () => {
  const groups = agentChoiceGroups(
    [
      { value: 'a', name: 'Anthropic/Claude Sonnet' },
      { value: 'b', name: 'OpenAI/GPT-5' },
      { value: 'c', name: 'Anthropic/Claude Haiku' }
    ],
    'opencode'
  );
  assert.deepEqual(
    groups.map((g) => [g.name, g.items.map((i) => i.label)]),
    [
      ['Anthropic', ['Claude Sonnet', 'Claude Haiku']],
      ['OpenAI', ['GPT-5']]
    ]
  );
});

test('prefers the group the agent sent over a name prefix', () => {
  const groups = agentChoiceGroups(
    [
      { value: 'a', name: 'gpt-5-codex', group: 'Recommended' },
      { value: 'b', name: 'o4-mini', group: 'Other' }
    ],
    'Codex'
  );
  assert.deepEqual(
    groups.map((g) => g.name),
    ['Recommended', 'Other']
  );
});
