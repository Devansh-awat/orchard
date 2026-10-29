export const MOMENT_MS = 15 * 60_000;

export const SYMPTOM_PANELS: Record<string, string> = {
	'error-rate': 'panel-error-rate',
	p95: 'panel-response-time',
	'memory-step': 'panel-memory',
	'memory-forecast': 'panel-memory',
	throttling: 'panel-cpu-throttling',
	'restart-burst': 'panel-restarts-and-out-of-memory-kills'
};

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
