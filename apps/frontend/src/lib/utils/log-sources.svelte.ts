import { apiFetch } from '$lib/stores';
import { ansiToHtmlLines } from './format';
import { buildLogLines, textLogLines, type LogLine } from './log-lines';

export type { LogLine } from './log-lines';

export const ansiLine = (line: string) => ansiToHtmlLines(line)[0];

export function ansiLogLines(text: string): LogLine[] {
	return textLogLines(text, ansiLine);
}

export function ansiBuildLines(raw: string | null | undefined): LogLine[] {
	return buildLogLines(raw, ansiLine);
}

const LOG_PAGE_SIZE = 500;
const LOG_INITIAL_LINES = 100;
export const LOG_MAX_LINES = 50_000;

export interface PodLogSourceOpts {
	podName: () => string;
	namespace: () => string;
	container: () => string;
	previous?: () => boolean;
	restarts?: () => number;
}

function restartMarker(at: Date) {
	const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	return `──── Restarted at ${time} · the output above is from before ────`;
}

export class PodLogSource {
	text = $state('');
	loading = $state(false);
	loadingMore = $state(false);
	error = $state<string | null>(null);
	atMax = $state(false);
	tailLines = $state(LOG_INITIAL_LINES);

	lines = $derived(ansiLogLines(this.text));
	atStart = $derived(this.atMax || this.tailLines >= LOG_MAX_LINES);

	#opts: PodLogSourceOpts;
	#carried = '';
	#target = '';
	#restarts: number | null = null;

	constructor(opts: PodLogSourceOpts) {
		this.#opts = opts;
	}

	resetPagination() {
		this.tailLines = LOG_INITIAL_LINES;
		this.atMax = false;
	}

	clear() {
		this.#carried = '';
		this.#target = '';
		this.#restarts = null;
		this.text = '';
		this.error = null;
		this.resetPagination();
	}

	async refresh(quiet = false) {
		const pod = this.#opts.podName();
		const container = this.#opts.container();
		if (!pod || !container) return;
		if (!quiet) this.loading = true;
		try {
			const prev = this.#opts.previous?.() ? '&previous=true' : '';
			const res = await apiFetch(
				`/apiv1/pods/${pod}/logs?namespace=${this.#opts.namespace()}&container=${container}&tailLines=${this.tailLines}${prev}`
			);
			if (res.ok) {
				const data = await res.json();
				const next: string = data.logs || '';
				const target = `${pod}/${container}/${prev}`;
				const restarts = this.#opts.restarts?.() ?? null;
				if (target !== this.#target) {
					this.#carried = '';
				} else if (
					!prev &&
					restarts !== null &&
					this.#restarts !== null &&
					restarts > this.#restarts &&
					this.text.trim()
				) {
					this.#carried = `${this.text.replace(/\n+$/, '')}\n${restartMarker(new Date())}\n`;
				}
				this.#target = target;
				this.#restarts = restarts;
				this.text = this.#carried + next;
				this.error = null;
			} else {
				const body = await res.json().catch(() => null);
				const detail = typeof body?.message === 'string' ? body.message : null;
				this.error = detail ? `Couldn't load logs: ${detail}` : "Couldn't load logs";
			}
		} catch {
			this.error = "Couldn't load logs";
		} finally {
			if (!quiet) this.loading = false;
		}
	}

	async loadEarlier() {
		if (this.loadingMore || this.atStart) return;
		this.loadingMore = true;
		const prevCount = this.text ? this.text.split('\n').length : 0;
		this.tailLines = Math.min(this.tailLines + LOG_PAGE_SIZE, LOG_MAX_LINES);
		try {
			await this.refresh();
			const nextCount = this.text ? this.text.split('\n').length : 0;
			if (nextCount <= prevCount) this.atMax = true;
		} finally {
			this.loadingMore = false;
		}
	}
}
