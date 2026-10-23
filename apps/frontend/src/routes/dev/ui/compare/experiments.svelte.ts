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
		id: 'eyebrow',
		label: 'Date above title',
		group: 'Header',
		options: [off, { value: 'date', label: 'Date' }, { value: 'org', label: 'Org' }],
		initial: 'off'
	},
	{
		id: 'search',
		label: 'Search',
		group: 'Header',
		options: [
			{ value: 'header', label: 'Corner' },
			{ value: 'wide', label: 'Wide' }
		],
		initial: 'header'
	},
	{
		id: 'summary',
		label: 'Fleet summary',
		group: 'Header',
		options: [
			off,
			{ value: 'sentence', label: 'Sentence' },
			{ value: 'numbers', label: 'Numbers' },
			{ value: 'rings', label: 'Rings' }
		],
		initial: 'off'
	},
	{
		id: 'hero',
		label: 'Featured project',
		group: 'Top',
		options: [
			off,
			{ value: 'spotlight', label: 'Spotlight' },
			{ value: 'banner', label: 'Banner' }
		],
		initial: 'off'
	},
	{
		id: 'upNext',
		label: 'Up next',
		group: 'Top',
		options: [off, { value: 'shelf', label: 'Shelf' }, { value: 'dock', label: 'Dock' }],
		initial: 'off'
	},
	{
		id: 'projects',
		label: 'Projects',
		group: 'Body',
		options: [
			{ value: 'groups', label: 'Folders' },
			{ value: 'tiles', label: 'Tiles' },
			{ value: 'list', label: 'List' }
		],
		initial: 'groups'
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
		initial: 'cards'
	},
	{
		id: 'sectionHeads',
		label: 'Section titles',
		group: 'Body',
		options: [off, { value: 'on', label: 'On' }],
		initial: 'off'
	},
	{
		id: 'cardMetrics',
		label: 'App card detail',
		group: 'Body',
		options: [
			{ value: 'text', label: 'Text' },
			{ value: 'spark', label: 'Traffic' }
		],
		initial: 'text'
	},
	{
		id: 'aside',
		label: 'Side column',
		group: 'Side',
		options: [
			off,
			{ value: 'widgets', label: 'Widgets' },
			{ value: 'resources', label: '+ Resources' }
		],
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

const KEY = 'orchard-dev-experiments';

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
