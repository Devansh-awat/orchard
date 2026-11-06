import { apiFetch } from '$lib/stores';
import { ansiToHtml } from '$lib/utils/format';
import { htmlToText, podBadge, type LogFilters, type LogLine } from '$lib/utils/log-lines';

export type LogEntry = {
	timestamp?: string;
	level?: string;
	message?: string;
	lines?: string[];
	raw?: string;
	metadata?: { pod?: unknown };
	_key?: string;
};

const INITIAL = 1000;
const PAGE = 2000;
const MAX = 20000;

const LEVEL_OF: Record<string, LogLine['level']> = {
	debug: 'debug',
	info: 'info',
	warn: 'warn',
	warning: 'warn',
	error: 'error',
	fatal: 'error'
};

function stripLeadingTime(line: string): string {
	return (
		line
			.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*/g, '')
			// oxlint-disable-next-line no-control-regex
			.replace(/^(?:\x1b\[[0-9;]*m|\s)*\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,6})?\s+/, '')
	);
}

function clock(ts?: string): string {
	if (!ts) return '';
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return '';
	const p = (n: number, w = 2) => String(n).padStart(w, '0');
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function keyed(next: LogEntry[], prev: LogEntry[]): LogEntry[] {
	const seen = new Map<string, number>();
	for (const e of next) {
		const base = `${e.timestamp ?? ''}|${e.raw ?? e.message ?? ''}`;
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		e._key = n ? `${base}#${n}` : base;
	}
	if (!prev.length) return next;
	const known = new Map(prev.map((e) => [e._key, e]));
	return next.map((e) => known.get(e._key) ?? e);
}

export function entryLine(e: LogEntry): LogLine {
	const body = stripLeadingTime((e.lines?.length ? e.lines : [e.message ?? '']).join('\n'));
	const { label: pod, html: podHtml } = podBadge(e.metadata?.pod);
	const time = clock(e.timestamp);
	const message = ansiToHtml(body);
	const ts = e.timestamp ? new Date(e.timestamp).getTime() : NaN;
	return {
		key: e._key ?? '',
		level: LEVEL_OF[(e.level ?? '').toLowerCase()],
		ts: Number.isFinite(ts) ? ts : null,
		source: pod || null,
		text: [time, pod, htmlToText(message)].filter(Boolean).join(' '),
		html: `<span class="log-ts">${time}</span>${podHtml}${message}`
	};
}

export type LogsSource = 'store' | 'live';

export type LogsQuery = {
	start: number;
	end: number | null;
	q: string;
	levels: string[];
	pods: string[];
};

const LEVEL_SETS: Record<LogFilters['level'], string[]> = {
	all: [],
	warn: ['warn', 'error'],
	error: ['error']
};

export function queryFrom(
	range: { start: number; end: number | null },
	filters: LogFilters | null
): LogsQuery {
	const w = filters?.window;
	return {
		start: w ? Math.max(range.start, w[0]) : range.start,
		end: w?.[1] != null ? (range.end == null ? w[1] : Math.min(range.end, w[1])) : range.end,
		q: filters?.query ?? '',
		levels: LEVEL_SETS[filters?.level ?? 'all'],
		pods: []
	};
}

export class LogsState {
	paused = $state(false);
	source = $state<LogsSource | null>(null);
	cursor = $state<string | null>(null);
	query = $state<LogsQuery | null>(null);

	entries = $state<LogEntry[]>([]);
	loading = $state(false);
	loadingMore = $state(false);
	error = $state<string | null>(null);
	tail = $state(INITIAL);
	atMax = $state(false);

	atStart = $derived(
		this.source === 'store' ? this.cursor === null : this.atMax || this.tail >= MAX
	);

	lines = $derived<LogLine[]>(this.entries.map(entryLine));

	#seq = 0;

	resetTail() {
		this.tail = INITIAL;
		this.atMax = false;
	}

	searchParams(q: LogsQuery, extra: Record<string, string> = {}) {
		const params = new URLSearchParams({
			start: String(q.start),
			end: String(q.end ?? Date.now()),
			...extra
		});
		if (q.q) params.set('q', q.q);
		if (q.levels.length) params.set('levels', q.levels.join(','));
		if (q.pods.length) params.set('pods', q.pods.join(','));
		return params;
	}

	exportUrl(id: string, format: 'text' | 'ndjson') {
		if (!this.query) return null;
		const params = this.searchParams(this.query, { format });
		return `/apiv1/observe/deployments/${encodeURIComponent(id)}/logs/export?${params}`;
	}

	async fetch(id: string, quiet = false) {
		if (this.query) return this.search(id, quiet);
		return this.fetchTail(id, quiet);
	}

	async search(id: string, quiet = false) {
		const q = this.query;
		if (!q) return 0;
		const seq = ++this.#seq;
		if (!this.entries.length && !quiet) this.loading = true;
		const params = this.searchParams(q, { limit: String(INITIAL) });
		try {
			const res = await apiFetch(
				`/apiv1/observe/deployments/${encodeURIComponent(id)}/logs/search?${params}`
			);
			if (seq !== this.#seq) return 0;
			if (res.status === 404) {
				this.query = null;
				return this.fetchTail(id, quiet);
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			if (seq !== this.#seq) return 0;
			const next: LogEntry[] = [...(body?.entries ?? [])].reverse();
			this.source = body?.source === 'store' ? 'store' : 'live';
			if (this.source === 'store') {
				const oldest = next[0]?.timestamp ?? '\uffff';
				const kept = quiet ? this.entries.filter((e) => (e.timestamp ?? '') < oldest) : [];
				this.entries = keyed([...kept, ...next], this.entries);
				if (!quiet) this.cursor = body?.cursor ?? null;
			} else {
				this.entries = keyed(next, this.entries);
				this.cursor = null;
			}
			this.error = null;
			return next.length;
		} catch (err) {
			if (seq === this.#seq) this.error = `Couldn't load logs: ${(err as Error).message}`;
			return 0;
		} finally {
			if (seq === this.#seq) this.loading = false;
		}
	}

	async fetchTail(id: string, quiet = false) {
		const seq = ++this.#seq;
		if (!this.entries.length && !quiet) this.loading = true;
		const params = new URLSearchParams({ tailLines: String(this.tail) });
		try {
			const res = await apiFetch(
				`/apiv1/observe/deployments/${encodeURIComponent(id)}/logs/structured?${params}`
			);
			if (seq !== this.#seq) return 0;
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			if (seq !== this.#seq) return 0;
			const next: LogEntry[] = body?.entries ?? body?.logs ?? body ?? [];
			this.entries = keyed(next, this.entries);
			this.error = null;
			return next.length;
		} catch (err) {
			if (seq === this.#seq) this.error = `Couldn't load logs: ${(err as Error).message}`;
			return 0;
		} finally {
			if (seq === this.#seq) this.loading = false;
		}
	}

	async loadEarlier(id: string) {
		if (this.loadingMore || this.atStart) return;
		if (this.source === 'store' && this.query && this.cursor) {
			this.loadingMore = true;
			const seq = ++this.#seq;
			try {
				const params = this.searchParams(this.query, {
					limit: String(PAGE),
					cursor: this.cursor
				});
				const res = await apiFetch(
					`/apiv1/observe/deployments/${encodeURIComponent(id)}/logs/search?${params}`
				);
				if (!res.ok || seq !== this.#seq) return;
				const body = await res.json();
				if (seq !== this.#seq) return;
				const older: LogEntry[] = [...(body?.entries ?? [])].reverse();
				this.entries = keyed([...older, ...this.entries], this.entries);
				this.cursor = body?.cursor ?? null;
			} finally {
				this.loadingMore = false;
			}
			return;
		}
		this.loadingMore = true;
		const before = this.entries.length;
		this.tail = Math.min(this.tail + PAGE, MAX);
		try {
			const count = await this.fetch(id, true);
			if (count <= before) this.atMax = true;
		} finally {
			this.loadingMore = false;
		}
	}
}
