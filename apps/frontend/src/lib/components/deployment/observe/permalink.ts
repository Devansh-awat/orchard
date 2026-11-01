export const MOMENT_MS = 15 * 60_000;

export const SYMPTOM_PANELS: Record<string, string> = {
	'error-rate': 'panel-error-rate',
	p95: 'panel-response-time',
	'memory-step': 'panel-memory',
	'memory-forecast': 'panel-memory',
	throttling: 'panel-cpu-throttling',
	'restart-burst': 'panel-restarts-and-out-of-memory-kills'
};

const OBSERVE_PARAMS = ['view', 'range', 'from', 'to', 'at', 'panel', 'q', 'levels', 'pod'];

export function releaseLink(base: string | URL, imageHistoryId: string): string {
	const url = new URL(base);
	for (const key of OBSERVE_PARAMS) url.searchParams.delete(key);
	url.searchParams.set('tab', 'deploys');
	url.searchParams.set('release', imageHistoryId);
	return url.toString();
}

export function momentLink(
	base: string | URL,
	opts: { at: number; panel?: string | null; view?: string; now?: number }
): string {
	const url = new URL(base);
	const now = opts.now ?? Date.now();
	url.searchParams.set('tab', 'observe');
	if (opts.view && opts.view !== 'metrics') url.searchParams.set('view', opts.view);
	else url.searchParams.delete('view');
	url.searchParams.delete('range');
	url.searchParams.set('from', String(Math.round(opts.at - MOMENT_MS)));
	url.searchParams.set('to', String(Math.round(Math.min(now, opts.at + MOMENT_MS))));
	url.searchParams.set('at', String(Math.round(opts.at)));
	if (opts.panel) url.searchParams.set('panel', opts.panel);
	else url.searchParams.delete('panel');
	return url.toString();
}

export function readMoment(url: URL): {
	from: number | null;
	to: number | null;
	range: string | null;
	at: number | null;
	panel: string | null;
} {
	const num = (k: string) => {
		const v = Number(url.searchParams.get(k));
		return Number.isFinite(v) && v > 0 ? v : null;
	};
	const from = num('from');
	const to = num('to');
	const valid = from != null && to != null && to > from;
	return {
		from: valid ? from : null,
		to: valid ? to : null,
		range: url.searchParams.get('range'),
		at: num('at'),
		panel: url.searchParams.get('panel')
	};
}

type Filters = {
	query: string;
	level: 'all' | 'warn' | 'error';
	window: [number, number | null] | null;
	source: string | null;
};

export function filtersFromUrl(url: URL): Filters | null {
	const q = url.searchParams.get('q') ?? '';
	const levels = (url.searchParams.get('levels') ?? '').split(',').filter(Boolean);
	const pod = url.searchParams.get('pod');
	if (!q && !levels.length && !pod) return null;
	const level =
		levels.includes('info') || levels.includes('debug') || !levels.length
			? 'all'
			: levels.includes('warn')
				? 'warn'
				: 'error';
	return { query: q, level, window: null, source: pod || null };
}

export function writeFilters(url: URL, f: Filters): URL {
	const next = new URL(url);
	if (f.query) next.searchParams.set('q', f.query);
	else next.searchParams.delete('q');
	if (f.level === 'all') next.searchParams.delete('levels');
	else next.searchParams.set('levels', f.level === 'warn' ? 'warn,error' : 'error');
	if (f.source) next.searchParams.set('pod', f.source);
	else next.searchParams.delete('pod');
	return next;
}
