export type Searchable = {
	name: string;
	displayName: string;
	description?: string;
	category?: string;
	tags: string[];
	keywords?: string[];
	author?: string;
	resources?: { name: string; type: string; detail?: string }[];
};

const SYNONYMS: Record<string, string[]> = {
	db: ['database', 'postgres', 'sql'],
	data: ['database', 'postgres', 'storage'],
	database: ['postgres', 'postgresql', 'sql', 'db'],
	postgres: ['database', 'postgresql', 'sql'],
	sql: ['database', 'postgres'],
	cache: ['redis', 'memory'],
	redis: ['cache', 'memory'],
	memory: ['cache', 'redis'],
	kv: ['key-value', 'redis'],
	blog: ['ghost', 'wordpress', 'writing', 'posts', 'cms'],
	cms: ['blog', 'wordpress', 'content'],
	write: ['blog', 'writing', 'posts'],
	writing: ['blog', 'posts'],
	post: ['blog', 'posts'],
	newsletter: ['blog', 'ghost'],
	site: ['website', 'static', 'html'],
	website: ['site', 'static', 'html', 'landing'],
	web: ['website', 'site', 'frontend'],
	static: ['website', 'html', 'nginx'],
	html: ['static', 'website'],
	landing: ['website', 'static'],
	page: ['website', 'static', 'pages'],
	bot: ['slack', 'chat', 'support'],
	chat: ['slack', 'bot'],
	slack: ['bot', 'chat', 'support'],
	helpdesk: ['support', 'tickets', 'bot'],
	support: ['helpdesk', 'tickets', 'bot'],
	ticket: ['support', 'helpdesk', 'tickets'],
	node: ['nodejs', 'javascript', 'js', 'express'],
	nodejs: ['node', 'javascript', 'js'],
	javascript: ['node', 'nodejs', 'js'],
	js: ['node', 'nodejs', 'javascript'],
	api: ['backend', 'server', 'node'],
	backend: ['api', 'server'],
	server: ['backend', 'api'],
	php: ['wordpress'],
	docker: ['image', 'container'],
	image: ['docker', 'container'],
	nginx: ['static', 'website']
};

const STOP = new Set([
	'a',
	'an',
	'the',
	'and',
	'or',
	'for',
	'with',
	'to',
	'of',
	'in',
	'on',
	'my',
	'me',
	'i',
	'some',
	'something',
	'that',
	'this',
	'is',
	'it',
	'like',
	'want',
	'need'
]);

function stem(word: string) {
	if (word.length > 5 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
	if (word.length > 4 && word.endsWith('ing')) return word.slice(0, -3);
	if (word.length > 4 && /(ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
	if (word.length > 3 && word.endsWith('s') && !/(ss|js|us|is)$/.test(word))
		return word.slice(0, -1);
	return word;
}

export function tokens(text: string) {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length > 1 && !STOP.has(w))
		.map(stem);
}

function close(a: string, b: string) {
	if (a === b) return 1;
	if (a.length >= 4 && b.startsWith(a) && b.length - a.length <= 2) return 0.8;
	if (a.length < 5 || Math.abs(a.length - b.length) > 1) return 0;
	let edits = 0;
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			i++;
			j++;
			continue;
		}
		if (++edits > 1) return 0;
		if (a.length > b.length) i++;
		else if (b.length > a.length) j++;
		else {
			i++;
			j++;
		}
	}
	edits += a.length - i + (b.length - j);
	return edits <= 1 ? 0.6 : 0;
}

type Field = { words: string[]; weight: number };

function fields(t: Searchable): Field[] {
	return [
		{ words: tokens(`${t.name} ${t.displayName}`), weight: 5 },
		{ words: (t.keywords ?? []).flatMap(tokens), weight: 4 },
		{ words: [...t.tags, t.category ?? ''].flatMap(tokens), weight: 3 },
		{ words: (t.resources ?? []).flatMap((r) => tokens(`${r.type} ${r.detail ?? ''}`)), weight: 2 },
		{ words: tokens(`${t.description ?? ''} ${t.author ?? ''}`), weight: 1 }
	];
}

function best(term: string, words: string[]) {
	let top = 0;
	for (const w of words) {
		const c = close(term, w);
		if (c > top) top = c;
		if (top === 1) break;
	}
	return top;
}

export function score(t: Searchable, query: string) {
	const terms = tokens(query);
	if (!terms.length) return 0;
	const fs = fields(t);
	let total = 0;
	let hits = 0;
	for (const term of terms) {
		let termScore = 0;
		for (const f of fs) termScore = Math.max(termScore, best(term, f.words) * f.weight);
		for (const syn of SYNONYMS[term] ?? []) {
			for (const f of fs)
				termScore = Math.max(termScore, best(stem(syn), f.words) * f.weight * 0.7);
		}
		if (termScore > 0) hits++;
		total += termScore;
	}
	return hits ? total * (hits / terms.length) : 0;
}

export function search<T extends Searchable>(items: T[], query: string): T[] {
	const q = query.trim();
	if (!q) return items;
	const ranked = items.map((item) => ({ item, s: score(item, q) })).filter((r) => r.s > 0);
	const top = Math.max(0, ...ranked.map((r) => r.s));
	return ranked
		.filter((r) => r.s >= top * 0.35)
		.sort((a, b) => b.s - a.s)
		.map((r) => r.item);
}
