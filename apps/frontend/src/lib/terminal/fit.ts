export interface FitDims {
	cols: number;
	rows: number;
}

export function settleResize(current: FitDims, proposed: FitDims | undefined): FitDims | null {
	if (!proposed) return null;
	const cols = Math.floor(proposed.cols);
	const rows = Math.floor(proposed.rows);
	if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
	if (cols < 2 || rows < 1) return null;
	if (cols === current.cols && rows === current.rows) return null;
	return { cols, rows };
}

export interface FitSchedulerOptions {
	host: HTMLElement;
	term: { readonly cols: number; readonly rows: number; resize(cols: number, rows: number): void };
	propose: () => FitDims | undefined;
	enabled: () => boolean;
	settleMs?: number;
}

export interface FitScheduler {
	schedule(): void;
	fitNow(): boolean;
	dispose(): void;
}

export function createFitScheduler(opts: FitSchedulerOptions): FitScheduler {
	const settleMs = opts.settleMs ?? 80;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;

	function fitNow(): boolean {
		if (disposed || !opts.enabled()) return false;
		const next = settleResize({ cols: opts.term.cols, rows: opts.term.rows }, opts.propose());
		if (!next) return false;
		opts.term.resize(next.cols, next.rows);
		return true;
	}

	function schedule(): void {
		if (disposed) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			fitNow();
		}, settleMs);
	}

	const observer = new ResizeObserver(() => schedule());
	observer.observe(opts.host);

	return {
		schedule,
		fitNow,
		dispose() {
			disposed = true;
			observer.disconnect();
			if (timer) clearTimeout(timer);
			timer = null;
		}
	};
}
