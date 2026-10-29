import type { ChartEvent, ChartPoint } from '$lib/components/ui/time-chart';

export type Anomaly = { t: number; kind: 'spike' | 'raised' | 'step'; label: string };

function median(values: number[]): number {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(values: number[]): number {
	return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
}

function duration(ms: number): string {
	const m = Math.max(1, Math.round(ms / 60_000));
	return m < 60 ? `${m}m` : `${(m / 60).toFixed(m % 60 ? 1 : 0)}h`;
}

function cause(t: number, step: number, events: ChartEvent[]): string | null {
	const before = Math.max(3 * step, 120_000);
	const hit = events
		.filter((e) => e.t <= t + step && e.t >= t - before)
		.sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
	return hit ? hit.label : null;
}

export function anomalies(
	points: ChartPoint[],
	opts: { format: (v: number) => string; events: ChartEvent[] }
): Anomaly[] {
	if (points.length < 12) return [];
	const ys = points.map((p) => p.y);
	const step = (points[points.length - 1].x - points[0].x) / (points.length - 1);
	const usual = median(ys);
	const spread = 1.4826 * median(ys.map((y) => Math.abs(y - usual)));
	const floor = Math.max(Math.abs(usual) * 0.05, 1e-9);
	const high = usual + Math.max(3.5 * spread, Math.abs(usual) * 0.25, floor);
	const out: Anomaly[] = [];

	let best: { start: number; end: number; area: number } | null = null;
	for (let i = 0; i < ys.length; i++) {
		if (ys[i] <= high) continue;
		let end = i;
		let area = 0;
		for (let j = i; j < ys.length && j - end <= 2; j++) {
			if (ys[j] <= high) continue;
			area += ys[j] - usual;
			end = j;
		}
		if (!best || area > best.area) best = { start: i, end, area };
		i = end;
	}
	if (best) {
		let peak = best.start;
		for (let i = best.start; i <= best.end; i++) if (ys[i] > ys[peak]) peak = i;
		const t = points[best.start].x;
		const times =
			usual > 0 ? `, ${(ys[peak] / usual).toFixed(1)}× the usual ${opts.format(usual)}` : '';
		const why = cause(t, step, opts.events);
		const long = best.end > best.start;
		out.push({
			t,
			kind: long ? 'raised' : 'spike',
			label: `${long ? `Up to ${opts.format(ys[peak])} for ${duration(points[best.end].x - t + step)}` : `Spike to ${opts.format(ys[peak])}`}${times}${why ? `. Lines up with ${why}` : ''}`
		});
	}

	const w = Math.max(5, Math.floor(ys.length / 6));
	let shift = { i: -1, diff: 0, before: 0, after: 0 };
	for (let i = w; i <= ys.length - w; i++) {
		const before = mean(ys.slice(Math.max(0, i - w), i));
		const after = mean(ys.slice(i));
		if (Math.abs(after - before) > Math.abs(shift.diff))
			shift = { i, diff: after - before, before, after };
	}
	const stepAt = Math.max(3.5 * spread, Math.abs(usual) * 0.3, floor);
	if (shift.i > 0 && Math.abs(shift.diff) > stepAt) {
		const t = points[shift.i].x;
		const overlaps = best && t >= points[best.start].x - w * step && t <= points[best.end].x + step;
		if (!overlaps) {
			const why = cause(t, step, opts.events);
			out.push({
				t,
				kind: 'step',
				label: `${shift.diff > 0 ? 'Stepped up' : 'Dropped'} from ${opts.format(shift.before)} to ${opts.format(shift.after)}${why ? `. Lines up with ${why}` : ''}`
			});
		}
	}
	return out;
}
