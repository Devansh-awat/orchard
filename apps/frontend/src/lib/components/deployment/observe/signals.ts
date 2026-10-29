import type { ChartBand, ChartPoint, ChartSeries } from '$lib/components/ui/time-chart';
import { SERIES_COLORS } from '$lib/components/ui/time-chart';

const BUCKETS = [
	60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000,
	43_200_000, 86_400_000
];

export function bucketSize(from: number, to: number, target = 40): number {
	return BUCKETS.find((b) => (to - from) / b <= target) ?? BUCKETS[BUCKETS.length - 1];
}

export type Occurrence = { t: number; key: string; n?: number };

export function stackByKey(
	items: Occurrence[],
	from: number,
	to: number,
	opts: {
		size: number;
		colors?: Record<string, string>;
		label?: (key: string) => string;
		since?: number;
	}
): ChartSeries[] {
	const start = Math.floor(Math.max(from, opts.since ?? from) / opts.size) * opts.size;
	const keys = [...new Set(items.filter((i) => i.t >= from && i.t <= to).map((i) => i.key))];
	return keys.map((key, k) => {
		const counts = new Map<number, number>();
		for (const i of items) {
			if (i.key !== key || i.t < from || i.t > to) continue;
			const b = Math.floor(i.t / opts.size) * opts.size;
			counts.set(b, (counts.get(b) ?? 0) + (i.n ?? 1));
		}
		const points: ChartPoint[] = [];
		for (let t = start; t <= to; t += opts.size)
			points.push({ x: t + opts.size / 2, y: counts.get(t) ?? 0 });
		return {
			id: key,
			label: opts.label ? opts.label(key) : key,
			points,
			color: opts.colors?.[key] ?? SERIES_COLORS[k % SERIES_COLORS.length]
		};
	});
}

export function runsAbove(
	points: ChartPoint[],
	limit: number,
	label: (peak: number, from: number, to: number) => string
): ChartBand[] {
	const out: ChartBand[] = [];
	if (points.length < 2) return out;
	const step = (points[points.length - 1].x - points[0].x) / (points.length - 1);
	let start: number | null = null;
	let peak = 0;
	for (let i = 0; i <= points.length; i++) {
		const p = points[i];
		if (p && p.y >= limit) {
			if (start === null) {
				start = p.x;
				peak = p.y;
			}
			peak = Math.max(peak, p.y);
			continue;
		}
		if (start !== null) {
			const end = points[i - 1].x + step / 2;
			out.push({ from: start - step / 2, to: end, label: label(peak, start, end), tone: 'error' });
			start = null;
		}
	}
	return out;
}

export function clock(t: number): string {
	return new Date(t).toLocaleTimeString(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	});
}
