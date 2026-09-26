export interface Person {
	id: string;
	name: string;
	username?: string;
	imageUrl?: string | null;
}

export interface TreeItem {
	id: string;
	name: string;
	type: 'organization' | 'project' | 'deployment' | 'ingress' | 'database' | 'templateInstance';
	href: string;
	slug?: string;
	orgName?: string;
	image?: string;
	faviconUrl?: string | null;
	ingressHost?: string;
	owner?: Person;
	children?: TreeItem[];
}

export type Span = [number, number];

export interface Match {
	score: number;
	spans: Span[];
}

export type PersonField = 'name' | 'username';

export interface Hit {
	item: TreeItem;
	project?: TreeItem;
	person?: Person;
	score: number;
	spans: Span[];
	via: 'self' | 'project' | 'person';
}

export interface Group {
	key: string;
	foreign?: boolean;
	project?: TreeItem;
	projectSpans?: Span[];
	projectMatched: boolean;
	person?: Person;
	personSpans?: Span[];
	personField?: PersonField;
	items: Hit[];
	topScore: number;
}

const SELF_PROJECT_BONUS = 200;
const SELF_LEAF_BONUS = 100;
const PERSON_PENALTY = 40;
const PROJECT_PENALTY = 80;

export function fuzzy(text: string, q: string): Match | null {
	if (!q) return null;
	const t = text.toLowerCase();
	const Q = q.toLowerCase();
	if (t === Q) return { score: 1000, spans: [[0, t.length]] };
	const idx = t.indexOf(Q);
	if (idx === 0) return { score: 850 - (t.length - Q.length), spans: [[0, Q.length]] };
	if (idx > 0)
		return { score: 700 - idx * 3 - (t.length - Q.length), spans: [[idx, idx + Q.length]] };
	let ti = 0;
	let qi = 0;
	let runStart = -1;
	const spans: Span[] = [];
	let boundaryHits = 0;
	while (ti < t.length && qi < Q.length) {
		if (t[ti] === Q[qi]) {
			if (runStart < 0) {
				runStart = ti;
				if (ti === 0 || /[\s\-_./]/.test(t[ti - 1])) boundaryHits++;
			}
			qi++;
			if (qi === Q.length || t[ti + 1] !== Q[qi]) {
				spans.push([runStart, ti + 1]);
				runStart = -1;
			}
		}
		ti++;
	}
	if (qi < Q.length) return null;
	const span = (spans[spans.length - 1]?.[1] ?? 0) - spans[0][0];
	return { score: 350 - (span - Q.length) * 2 + boundaryHits * 25, spans };
}

// A person matches on their display name or their username, whichever scores
// better, so both "sebastian" and "sebmota" land on the same human. Which field
// won comes back too, since the spans index into that string.
export function personMatch(
	person: Person,
	q: string
): { match: Match; field: PersonField } | null {
	const byName = fuzzy(person.name, q);
	const byUser = person.username ? fuzzy(person.username, q) : null;
	if (byName && (!byUser || byName.score >= byUser.score)) {
		return { match: byName, field: 'name' };
	}
	if (byUser) return { match: byUser, field: 'username' };
	return null;
}

interface Flat {
	item: TreeItem;
	project?: TreeItem;
}

export function flatten(items: TreeItem[], project?: TreeItem): Flat[] {
	const out: Flat[] = [];
	for (const item of items) {
		if (item.type === 'ingress') continue;
		if (item.type === 'organization') {
			out.push({ item });
			if (item.children) out.push(...flatten(item.children));
			continue;
		}
		if (item.type === 'project') {
			out.push({ item, project: item });
			if (item.children) out.push(...flatten(item.children, item));
		} else {
			out.push({ item, project });
			if (item.children) out.push(...flatten(item.children, project));
		}
	}
	return out;
}

export function searchResults(tree: TreeItem[], query: string): { groups: Group[]; flat: Hit[] } {
	const Q = query.trim();
	if (!Q) return { groups: [], flat: [] };
	const flat = flatten(tree);

	const projectMatch = new Map<string, Match>();
	for (const { item } of flat) {
		if (item.type === 'project') {
			const m = fuzzy(item.name, Q);
			if (m) projectMatch.set(item.id, m);
		}
	}

	// Everyone who owns something in this org, matched once each.
	const people = new Map<string, Person>();
	for (const { item } of flat) {
		if (item.owner && !people.has(item.owner.id)) people.set(item.owner.id, item.owner);
	}
	const peopleMatch = new Map<string, { person: Person; match: Match; field: PersonField }>();
	for (const person of people.values()) {
		const m = personMatch(person, Q);
		if (m) peopleMatch.set(person.id, { person, match: m.match, field: m.field });
	}

	// Every item keeps only its strongest provenance. A deployment called
	// "bobcat" found by typing "bob" is a name hit, not one of Bob's apps.
	const best = new Map<string, Hit>();
	const consider = (hit: Hit) => {
		const current = best.get(hit.item.id);
		if (!current || hit.score > current.score) best.set(hit.item.id, hit);
	};

	for (const { item, project } of flat) {
		const m = fuzzy(item.name, Q);
		if (m) {
			const bonus = item.type === 'project' ? SELF_PROJECT_BONUS : SELF_LEAF_BONUS;
			consider({ item, project, score: m.score + bonus, spans: m.spans, via: 'self' });
		}
		const owner = item.owner ? peopleMatch.get(item.owner.id) : undefined;
		if (owner) {
			consider({
				item,
				project,
				person: owner.person,
				score: owner.match.score - PERSON_PENALTY,
				spans: [],
				via: 'person'
			});
		}
		if (item.type !== 'project' && project && projectMatch.has(project.id)) {
			const pm = projectMatch.get(project.id)!;
			consider({ item, project, score: pm.score - PROJECT_PENALTY, spans: [], via: 'project' });
		}
	}

	// Group by whoever explains the hit: the matched person, else the project,
	// else a root bucket.
	const groupMap = new Map<string, Group>();
	for (const h of best.values()) {
		const key =
			h.via === 'person' && h.person ? `person:${h.person.id}` : (h.project?.id ?? '__root');
		let g = groupMap.get(key);
		if (!g) {
			const pm = h.project ? projectMatch.get(h.project.id) : undefined;
			const pmatch = h.via === 'person' && h.person ? peopleMatch.get(h.person.id) : undefined;
			g = {
				key,
				project: h.via === 'person' ? undefined : h.project,
				projectSpans: h.via === 'person' ? undefined : pm?.spans,
				projectMatched: h.via === 'person' ? false : !!pm,
				person: h.via === 'person' ? h.person : undefined,
				personSpans: pmatch?.match.spans,
				personField: pmatch?.field,
				items: [],
				topScore: 0
			};
			groupMap.set(key, g);
		}
		g.items.push(h);
		if (h.score > g.topScore) g.topScore = h.score;
	}

	const groups = [...groupMap.values()];
	for (const g of groups) {
		g.items.sort((a, b) => b.score - a.score);
	}
	groups.sort((a, b) => b.topScore - a.topScore);

	// Flat ordered list mirroring render order, used for keyboard navigation.
	const flatHits: Hit[] = [];
	for (const g of groups) {
		for (const h of g.items) flatHits.push(h);
	}
	return { groups, flat: flatHits };
}

export function foreignResults(tree: TreeItem[], query: string): { groups: Group[]; flat: Hit[] } {
	const { groups, flat } = searchResults(tree, query);
	for (const g of groups) g.foreign = true;
	return { groups, flat };
}

export function mergeResults(
	home: { groups: Group[]; flat: Hit[] },
	away: { groups: Group[]; flat: Hit[] }
): { groups: Group[]; flat: Hit[] } {
	return { groups: [...home.groups, ...away.groups], flat: [...home.flat, ...away.flat] };
}

// Highlight matched character ranges. `offset` shifts spans that were computed
// against a bare string into one rendered with a prefix, e.g. "@" before a
// username.
export function segments(
	name: string,
	spans: Span[] | undefined,
	offset = 0
): { text: string; hit: boolean }[] {
	if (!spans || spans.length === 0) return [{ text: name, hit: false }];
	const out: { text: string; hit: boolean }[] = [];
	let cursor = 0;
	for (const [rawStart, rawEnd] of spans) {
		const s = rawStart + offset;
		const e = rawEnd + offset;
		if (s > cursor) out.push({ text: name.slice(cursor, s), hit: false });
		out.push({ text: name.slice(s, e), hit: true });
		cursor = e;
	}
	if (cursor < name.length) out.push({ text: name.slice(cursor), hit: false });
	return out;
}

export type ActionKind = 'navigate' | 'call' | 'copy' | 'open';

export interface Action {
	id: string;
	label: string;
	kind: ActionKind;
	href?: string;
	method?: 'POST';
	path?: string;
	copyField?: 'href' | 'url' | 'connectionString';
	danger?: boolean;
	key?: string;
}

export function actionsFor(item: TreeItem): Action[] {
	const open: Action = { id: 'open', label: 'Open', kind: 'navigate', href: item.href, key: '↵' };
	switch (item.type) {
		case 'deployment': {
			const actions: Action[] = [
				open,
				{
					id: 'logs',
					label: 'Logs',
					kind: 'navigate',
					href: `${item.href}?tab=observe&view=logs`,
					key: 'L'
				},
				{
					id: 'metrics',
					label: 'Metrics',
					kind: 'navigate',
					href: `${item.href}?tab=observe&view=metrics`,
					key: 'M'
				},
				{
					id: 'activity',
					label: 'Activity',
					kind: 'navigate',
					href: `${item.href}?tab=deploys`,
					key: 'A'
				},
				{
					id: 'settings',
					label: 'Settings',
					kind: 'navigate',
					href: `${item.href}?tab=settings`,
					key: ','
				},
				{
					id: 'restart',
					label: 'Restart',
					kind: 'call',
					method: 'POST',
					path: `/apiv1/deployments/${item.id}/restart`,
					key: 'R'
				},
				{
					id: 'redeploy',
					label: 'Redeploy',
					kind: 'call',
					method: 'POST',
					path: `/apiv1/deployments/${item.id}/rebuild`,
					key: 'D'
				}
			];
			if (item.ingressHost) {
				actions.push(
					{
						id: 'visit',
						label: 'Open in browser',
						kind: 'open',
						href: `https://${item.ingressHost}`,
						key: 'O'
					},
					{ id: 'copy-url', label: 'Copy URL', kind: 'copy', copyField: 'url', key: 'C' }
				);
			}
			return actions;
		}
		case 'database':
			return [
				open,
				{
					id: 'connection',
					label: 'Connection',
					kind: 'navigate',
					href: `${item.href}?tab=connection`,
					key: 'N'
				},
				{
					id: 'queries',
					label: 'Queries',
					kind: 'navigate',
					href: `${item.href}?tab=queries`,
					key: 'Q'
				},
				{
					id: 'copy-connection',
					label: 'Copy connection string',
					kind: 'copy',
					copyField: 'connectionString',
					key: 'C'
				},
				{
					id: 'restart',
					label: 'Restart',
					kind: 'call',
					method: 'POST',
					path: `/apiv1/databases/${item.id}/restart`,
					key: 'R'
				}
			];
		case 'organization':
			return [{ id: 'switch', label: 'Switch to', kind: 'navigate', href: item.href, key: '↵' }];
		case 'project': {
			const org = item.href.split('/')[1] ?? '';
			return [
				open,
				{
					id: 'new-app',
					label: 'New app here',
					kind: 'navigate',
					href: `/${org}/deployments/new?project=${encodeURIComponent(item.slug ?? item.name)}`,
					key: 'N'
				}
			];
		}
		default:
			return [open];
	}
}

export interface FrecencyEntry {
	count: number;
	last: number;
}

export type Frecency = Record<string, FrecencyEntry>;

const DAY_MS = 24 * 60 * 60 * 1000;
const FRECENCY_MAX = 160;
const FRECENCY_PER_USE = 45;
const FRECENCY_HALF_LIFE_DAYS = 7;

export function frecencyScore(entry: FrecencyEntry | undefined, now: number): number {
	if (!entry || entry.count <= 0) return 0;
	const ageDays = Math.max(0, now - entry.last) / DAY_MS;
	const decay = Math.pow(0.5, ageDays / FRECENCY_HALF_LIFE_DAYS);
	return Math.min(FRECENCY_MAX, FRECENCY_PER_USE * entry.count) * decay;
}

export function recordUse(frecency: Frecency, id: string, now: number): Frecency {
	const prev = frecency[id];
	return { ...frecency, [id]: { count: (prev?.count ?? 0) + 1, last: now } };
}

export function recentItems(
	tree: TreeItem[],
	frecency: Frecency,
	now: number,
	limit = 6
): TreeItem[] {
	const byId = new Map<string, TreeItem>();
	for (const { item } of flatten(tree)) byId.set(item.id, item);
	return Object.entries(frecency)
		.map(([id, entry]) => ({ item: byId.get(id), score: frecencyScore(entry, now) }))
		.filter((x): x is { item: TreeItem; score: number } => !!x.item && x.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((x) => x.item);
}

export function rankedResults(
	tree: TreeItem[],
	query: string,
	frecency: Frecency,
	now: number
): { groups: Group[]; flat: Hit[] } {
	const base = searchResults(tree, query);
	if (base.flat.length === 0) return base;
	for (const group of base.groups) {
		for (const hit of group.items) hit.score += frecencyScore(frecency[hit.item.id], now);
		group.items.sort((a, b) => b.score - a.score);
		group.topScore = group.items[0]?.score ?? 0;
	}
	base.groups.sort((a, b) => b.topScore - a.topScore);
	const flat: Hit[] = [];
	for (const g of base.groups) for (const h of g.items) flat.push(h);
	return { groups: base.groups, flat };
}
