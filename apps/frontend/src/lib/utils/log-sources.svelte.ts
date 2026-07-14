import { apiFetch } from '$lib/stores';
import { ansiToHtmlLines } from '$lib/utils/format';

export interface LogLine {
	key: string;
	html: string;
	level?: 'debug' | 'info' | 'warn' | 'error';
	detail?: string[];
	lineNo?: number;
}

export function ansiLogLines(text: string): LogLine[] {
	if (!text) return [];
	const seen = new Map<string, number>();
	return ansiToHtmlLines(text).map((html) => {
		const n = seen.get(html) ?? 0;
		seen.set(html, n + 1);
		return { key: n ? `${html}#${n}` : html, html };
	});
}

const LOG_PAGE_SIZE = 500;
const LOG_INITIAL_LINES = 100;
export const LOG_MAX_LINES = 50_000;

export interface PodLogSourceOpts {
	podName: () => string;
	namespace: () => string;
	container: () => string;
	previous?: () => boolean;
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

	constructor(opts: PodLogSourceOpts) {
		this.#opts = opts;
	}

	resetPagination() {
		this.tailLines = LOG_INITIAL_LINES;
		this.atMax = false;
	}

	clear() {
		this.text = '';
		this.error = null;
		this.resetPagination();
	}

	async refresh() {
		const pod = this.#opts.podName();
		const container = this.#opts.container();
		if (!pod || !container) return;
		this.loading = true;
		try {
			const prev = this.#opts.previous?.() ? '&previous=true' : '';
			const res = await apiFetch(
				`/apiv1/pods/${pod}/logs?namespace=${this.#opts.namespace()}&container=${container}&tailLines=${this.tailLines}${prev}`
			);
			if (res.ok) {
				const data = await res.json();
				this.text = data.logs || '';
				this.error = null;
			} else {
				this.error = 'Failed to load logs';
			}
		} catch {
			this.error = 'Failed to load logs';
		} finally {
			this.loading = false;
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
