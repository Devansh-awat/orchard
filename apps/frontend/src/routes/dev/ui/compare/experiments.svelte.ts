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
		id: 'density',
		label: 'Projects',
		group: 'Body',
		options: [
			{ value: 'regular', label: 'Folders' },
			{ value: 'compact', label: 'Compact' }
		],
		initial: 'regular'
	},
	{
		id: 'appLayout',
		label: 'Apps inside a project',
		group: 'Body',
		options: [
			{ value: 'cards', label: 'Cards' },
			{ value: 'dense', label: 'Dense' },
			{ value: 'rows', label: 'Rows' }
		],
		initial: 'dense'
	},
	{
		id: 'cardMetrics',
		label: 'App detail',
		group: 'Body',
		options: [
			{ value: 'text', label: 'Text' },
			{ value: 'spark', label: 'Traffic' }
		],
		initial: 'spark'
	},
	{
		id: 'aside',
		label: 'Side column',
		group: 'Side',
		options: [off, { value: 'widgets', label: 'Widgets' }],
		initial: 'widgets'
	},
	{
		id: 'wallpaper',
		label: 'Wallpaper tint',
		group: 'Surface',
		options: [off, { value: 'subtle', label: 'Subtle' }, { value: 'rich', label: 'Rich' }],
		initial: 'subtle'
	}
];

const KEY = 'orchard-dev-experiments-v2';

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
