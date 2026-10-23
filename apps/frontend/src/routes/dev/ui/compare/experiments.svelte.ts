export type Experiment = {
	id: string;
	label: string;
	group: string;
	options: { value: string; label: string }[];
	initial: string;
};

const off = { value: 'off', label: 'Off' };

export const EXPERIMENTS: Experiment[] = [
	{
		id: 'island',
		label: 'Live island',
		group: 'Organic',
		options: [off, { value: 'on', label: 'On' }],
		initial: 'on'
	},
	{
		id: 'newButton',
		label: 'New button',
		group: 'Organic',
		options: [
			{ value: 'plain', label: 'Plain' },
			{ value: 'liquid', label: 'Liquid' }
		],
		initial: 'liquid'
	},
	{
		id: 'liquidNav',
		label: 'Sidebar highlight',
		group: 'Organic',
		options: [
			{ value: 'off', label: 'Plain' },
			{ value: 'on', label: 'Liquid' }
		],
		initial: 'on'
	},
	{
		id: 'search',
		label: 'Search',
		group: 'Organic',
		options: [
			{ value: 'field', label: 'Field' },
			{ value: 'spotlight', label: 'Spotlight' }
		],
		initial: 'spotlight'
	},
	{
		id: 'failDrop',
		label: 'Failure droplet',
		group: 'Organic',
		options: [off, { value: 'on', label: 'On' }],
		initial: 'on'
	},
	{
		id: 'density',
		label: 'Projects',
		group: 'Layout',
		options: [
			{ value: 'regular', label: 'Folders' },
			{ value: 'compact', label: 'Compact' }
		],
		initial: 'regular'
	}
];

export type ExperimentAction = { id: string; label: string };

export const ACTIONS: ExperimentAction[] = [
	{ id: 'build', label: 'Start a build' },
	{ id: 'build2', label: 'Second build' },
	{ id: 'succeed', label: 'Build succeeds' },
	{ id: 'fail-build', label: 'Build fails' },
	{ id: 'crash', label: 'An app crashes' }
];

const listeners = new Set<(id: string) => void>();

export function onAction(fn: (id: string) => void) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function runAction(id: string) {
	for (const fn of listeners) fn(id);
}

const KEY = 'orchard-dev-experiments-v3';

function load(): Record<string, string> {
	const base = Object.fromEntries(EXPERIMENTS.map((e) => [e.id, e.initial]));
	if (typeof localStorage === 'undefined') return base;
	try {
		const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
		for (const e of EXPERIMENTS) {
			if (e.options.some((o) => o.value === saved[e.id])) base[e.id] = saved[e.id];
		}
	} catch {
		return base;
	}
	return base;
}

export const exp = $state(load());

export function persist() {
	localStorage.setItem(KEY, JSON.stringify(exp));
}

export function reset() {
	for (const e of EXPERIMENTS) exp[e.id] = e.initial;
	persist();
}

export function picks() {
	return EXPERIMENTS.map((e) => {
		const o = e.options.find((x) => x.value === exp[e.id]);
		return `${e.label}: ${o?.label ?? exp[e.id]}`;
	}).join('\n');
}
