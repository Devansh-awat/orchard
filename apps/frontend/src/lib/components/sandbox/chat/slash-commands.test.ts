import test from 'node:test';
import assert from 'node:assert/strict';
import {
	LOCAL_COMMANDS,
	bestOption,
	effortOptions,
	findCommand,
	mergeCommands,
	parseSlash,
	parseTodos,
	pickEffort,
	primaryAgents,
	rankCommands,
	rankOptions,
	runsImmediately,
	sectionsOf,
	serverCommands,
	transcriptMarkdown,
	undoTarget,
	visibleCommands,
	exportFileName,
	commandLine,
	securityReviewPrompt,
	reviewPrompt,
	type SlashCommand
} from './slash-commands';

const names = (list: readonly { name: string }[]) => list.map((c) => c.name);

test('a slash line splits into a lowercase name and trimmed arguments', () => {
	assert.deepEqual(parseSlash('/compact'), { name: 'compact', args: '' });
	assert.deepEqual(parseSlash('/Rename  New title  '), { name: 'rename', args: 'New title' });
	assert.deepEqual(parseSlash('/chat hi\nthere'), { name: 'chat', args: 'hi\nthere' });
	assert.equal(parseSlash('hello /compact'), null);
	assert.equal(parseSlash('/'), null);
	assert.equal(parseSlash(' /compact'), null);
});

test('commands resolve by name or alias, and unknown names stay prompts', () => {
	assert.equal(findCommand(LOCAL_COMMANDS, 'undo')?.command.name, 'undo');
	assert.deepEqual(
		findCommand(LOCAL_COMMANDS, 'rewind') && {
			name: findCommand(LOCAL_COMMANDS, 'rewind')?.command.name,
			alias: findCommand(LOCAL_COMMANDS, 'rewind')?.alias
		},
		{ name: 'undo', alias: 'rewind' }
	);
	assert.equal(findCommand(LOCAL_COMMANDS, 'cost')?.command.name, 'context');
	assert.equal(findCommand(LOCAL_COMMANDS, 'config')?.command.name, 'settings');
	assert.equal(findCommand(LOCAL_COMMANDS, 'feedback')?.command.name, 'bug');
	assert.equal(findCommand(LOCAL_COMMANDS, 'usr/bin'), null);
});

test('the built in registry has unique names and aliases and no cloud-irrelevant commands', () => {
	const all = LOCAL_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
	assert.equal(new Set(all).size, all.length);
	for (const omitted of ['vim', 'doctor', 'logout', 'exit', 'hooks', 'ide', 'upgrade']) {
		assert.equal(findCommand(LOCAL_COMMANDS, omitted), null, omitted);
	}
	for (const command of LOCAL_COMMANDS) {
		assert.ok(command.group, command.name);
		assert.ok(!command.description.includes(String.fromCharCode(0x2014)), command.name);
	}
});

test('server commands parse hints and fall back to a description by source', () => {
	const parsed = serverCommands([
		{
			name: 'init',
			description: 'guided AGENTS.md setup',
			source: 'command',
			hints: ['$ARGUMENTS']
		},
		{ name: 'review', source: 'command', hints: [] },
		{ name: 'deploy', description: 'Ship it', source: 'command', hints: ['$1', '$2'] },
		{ name: 'pdf', source: 'skill', hints: [] },
		{ name: 'gh-prompt', source: 'mcp', hints: ['$1'] },
		{ name: 'has space', hints: [] },
		{ name: 'deploy', hints: [] },
		null,
		{ description: 'nameless' }
	]);
	assert.deepEqual(names(parsed), ['init', 'review', 'deploy', 'pdf', 'gh-prompt']);
	assert.equal(parsed[0].group, 'agent');
	assert.equal(parsed[0].hint, '[arguments]');
	assert.equal(parsed[0].args, 'optional');
	assert.equal(parsed[2].group, 'repository');
	assert.equal(parsed[2].hint, '<1> <2>');
	assert.equal(parsed[3].description, 'Skill');
	assert.equal(parsed[3].args, 'none');
	assert.equal(parsed[4].description, 'MCP prompt');
	assert.ok(parsed.every((c) => c.source === 'server'));
	assert.deepEqual(serverCommands({ not: 'a list' }), []);
});

test('merging prefers opencode only for init and review and drops other collisions', () => {
	const server = serverCommands([
		{ name: 'init', description: 'guided AGENTS.md setup', hints: ['$ARGUMENTS'] },
		{ name: 'review', description: 'review changes', hints: ['$ARGUMENTS'] },
		{ name: 'compact', description: 'their compact', hints: [] },
		{ name: 'cost', description: 'collides with an alias', hints: [] },
		{ name: 'deploy', description: 'Ship it', hints: [] }
	]);
	const merged = mergeCommands(LOCAL_COMMANDS, server);
	assert.equal(findCommand(merged, 'init')?.command.source, 'server');
	assert.equal(findCommand(merged, 'init')?.command.description, 'guided AGENTS.md setup');
	assert.equal(findCommand(merged, 'review')?.command.source, 'server');
	assert.equal(findCommand(merged, 'compact')?.command.source, 'local');
	assert.equal(findCommand(merged, 'cost')?.command.name, 'context');
	assert.equal(findCommand(merged, 'deploy')?.command.source, 'server');
	assert.equal(merged.filter((c) => c.name === 'init').length, 1);
	assert.equal(merged.length, LOCAL_COMMANDS.length + 1);
});

test('viewers only see the read only commands', () => {
	const merged = mergeCommands(LOCAL_COMMANDS, serverCommands([{ name: 'deploy', hints: [] }]));
	assert.deepEqual(names(visibleCommands(merged, false)).sort(), [
		'context',
		'diff',
		'export',
		'help',
		'status',
		'todos'
	]);
	assert.equal(visibleCommands(merged, true).length, merged.length);
});

test('ranking matches names, aliases and descriptions and keeps groups in order', () => {
	const top = (q: string) => rankCommands(LOCAL_COMMANDS, q)[0];
	assert.equal(top('comp')?.command.name, 'compact');
	assert.equal(top('rew')?.label, 'rewind');
	assert.equal(top('rew')?.command.name, 'undo');
	assert.equal(top('secrev')?.command.name, 'security-review');
	assert.ok(rankCommands(LOCAL_COMMANDS, 'markdown').some((m) => m.command.name === 'export'));
	assert.equal(rankCommands(LOCAL_COMMANDS, 'zzzz').length, 0);
	const all = rankCommands(LOCAL_COMMANDS, '');
	assert.equal(all.length, LOCAL_COMMANDS.length);
	const sections = sectionsOf(all);
	assert.deepEqual(
		sections.map((s) => s.label),
		['Chat', 'Agent', 'Machine']
	);
	assert.deepEqual(
		sections.flatMap((s) => s.items.map((i) => i.index)),
		all.map((_, i) => i)
	);
});

test('ranking a repository command lands in the repository group', () => {
	const merged = mergeCommands(LOCAL_COMMANDS, serverCommands([{ name: 'deploy', hints: [] }]));
	const sections = sectionsOf(rankCommands(merged, 'dep'));
	assert.equal(sections.at(-1)?.label, 'Repository');
	assert.equal(sections.at(-1)?.items[0].match.command.name, 'deploy');
});

test('argless commands run on send, the rest complete first', () => {
	const by = (name: string) => findCommand(LOCAL_COMMANDS, name)?.command as SlashCommand;
	assert.equal(runsImmediately(by('compact'), false), true);
	assert.equal(runsImmediately(by('model'), false), true);
	assert.equal(runsImmediately(by('effort'), true), false);
	assert.equal(runsImmediately(by('rename'), false), false);
	assert.equal(commandLine(by('rename')), '/rename <title>');
	assert.equal(commandLine(by('undo'), 'rewind'), '/rewind');
});

test('options rank by value, label and description', () => {
	const options = [
		{ value: 'ses_1', label: 'Fix the login bug' },
		{ value: 'ses_2', label: 'Add dark mode', description: 'theme work' }
	];
	assert.equal(bestOption(options, 'login')?.value, 'ses_1');
	assert.equal(bestOption(options, 'theme')?.value, 'ses_2');
	assert.equal(rankOptions(options, '').length, 2);
	assert.equal(bestOption(options, 'qqq'), null);
});

test('effort picks a variant by exact or prefix match, and default clears it', () => {
	const variants = ['low', 'medium', 'high', 'max'];
	assert.equal(pickEffort(variants, 'HIGH'), 'high');
	assert.equal(pickEffort(variants, 'med'), 'medium');
	assert.equal(pickEffort(variants, 'default'), null);
	assert.equal(pickEffort(variants, 'turbo'), undefined);
	assert.equal(pickEffort(variants, ''), undefined);
	assert.deepEqual(
		effortOptions(['low']).map((o) => o.value),
		['default', 'low']
	);
});

test('only primary visible agents are offered', () => {
	assert.deepEqual(
		primaryAgents([
			{ name: 'build', mode: 'primary', description: 'Default agent' },
			{ name: 'plan', mode: 'primary' },
			{ name: 'general', mode: 'subagent' },
			{ name: 'title', mode: 'primary', hidden: true },
			{ name: 'docs', mode: 'all', description: ' Writes docs ' },
			{ mode: 'primary' }
		]),
		[
			{ name: 'build', description: 'Default agent' },
			{ name: 'plan', description: '' },
			{ name: 'docs', description: 'Writes docs' }
		]
	);
});

test('todos parse with defaults and skip empty items', () => {
	assert.deepEqual(
		parseTodos([
			{ content: 'Write tests', status: 'completed', priority: 'high' },
			{ content: '  ' },
			{ content: 'Ship' }
		]),
		[
			{ content: 'Write tests', status: 'completed', priority: 'high' },
			{ content: 'Ship', status: 'pending', priority: 'medium' }
		]
	);
	assert.deepEqual(parseTodos(null), []);
});

test('undo targets the last prompt before any existing revert', () => {
	const entries = [
		{ kind: 'user', messageID: 'm1' },
		{ kind: 'text' },
		{ kind: 'user' },
		{ kind: 'user', messageID: 'm2' },
		{ kind: 'user', messageID: 'm3' }
	];
	assert.equal(undoTarget(entries, null), 'm3');
	assert.equal(undoTarget(entries, 'm3'), 'm2');
	assert.equal(undoTarget(entries, 'm1'), null);
	assert.equal(undoTarget([], null), null);
});

test('the transcript exports as markdown with prompts quoted and tool runs listed', () => {
	const md = transcriptMarkdown('Fix login', [
		{ kind: 'user', text: 'Fix it\nplease' },
		{ kind: 'thinking', text: 'hmm' },
		{ kind: 'tool', name: 'Bash', summary: 'pnpm test' },
		{ kind: 'agent', agentType: 'explore', description: 'Find the bug' },
		{ kind: 'text', text: 'Done.' },
		{ kind: 'error', detail: 'Rate limited' },
		{ kind: 'note', lead: 'Allowed', target: 'npm test' },
		{ kind: 'user', text: '', attachments: [{}] }
	]);
	assert.equal(
		md,
		[
			'# Fix login',
			'## Prompt\n\n> Fix it\n> please',
			'- Bash `pnpm test`\n- explore: Find the bug',
			'Done.',
			'**Error:** Rate limited',
			'_Allowed npm test_',
			'## Prompt\n\n> 1 attachment(s)'
		].join('\n\n') + '\n'
	);
	assert.equal(exportFileName('Fix: the Login!'), 'fix-the-login.md');
	assert.equal(exportFileName('***'), 'chat.md');
});

test('the review prompt covers uncommitted changes or a given target', () => {
	assert.ok(reviewPrompt('').includes('git diff --cached'));
	assert.ok(reviewPrompt(' main ').startsWith('Review main.'));
});

test('the security review names the base branch when known', () => {
	assert.ok(securityReviewPrompt('main').includes('`git diff main...HEAD`'));
	assert.ok(securityReviewPrompt(null).includes('the diff against the base branch'));
});
