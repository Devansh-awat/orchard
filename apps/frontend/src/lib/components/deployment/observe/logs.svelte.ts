import { apiFetch } from '$lib/stores';
import { ansiToHtml, podLabel } from '$lib/utils/format';
import { htmlToText, type LogLine } from '$lib/utils/log-lines';

export type LogEntry = {
	timestamp?: string;
	level?: string;
	message?: string;
	lines?: string[];
	raw?: string;
	metadata?: { pod?: string };
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
	const pod = e.metadata?.pod ? podLabel(e.metadata.pod) : '';
	const time = clock(e.timestamp);
	const message = ansiToHtml(body);
	const ts = e.timestamp ? new Date(e.timestamp).getTime() : NaN;
	return {
		key: e._key ?? '',
		level: LEVEL_OF[(e.level ?? '').toLowerCase()],
		ts: Number.isFinite(ts) ? ts : null,
		source: pod || null,
		text: [time, pod, htmlToText(message)].filter(Boolean).join(' '),
		html: `<span class="log-ts">${time}</span>${pod ? `<span class="log-pod">${pod}</span>` : ''}${message}`
	};
}

export class LogsState {
	paused = $state(false);

	entries = $state<LogEntry[]>([]);
	loading = $state(false);
	loadingMore = $state(false);
	error = $state<string | null>(null);
	tail = $state(INITIAL);
	atMax = $state(false);

	atStart = $derived(this.atMax || this.tail >= MAX);

	lines = $derived<LogLine[]>(this.entries.map(entryLine));

	#seq = 0;

	resetTail() {
		this.tail = INITIAL;
		this.atMax = false;
	}

	async fetch(id: string, quiet = false) {
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
