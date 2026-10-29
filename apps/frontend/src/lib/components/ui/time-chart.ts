export type ChartPoint = { x: number; y: number };
export type ChartTone = 'neutral' | 'accent' | 'warning' | 'error' | 'faint';
export type ChartDisplay = 'lines' | 'areas' | 'bars' | 'stacked' | 'stackedAreas';
export type ChartSeries = {
	id: string;
	label?: string;
	points: ChartPoint[];
	tone?: ChartTone;
	color?: string;
	dashed?: boolean;
};
export type ChartEvent = { t: number; label: string; tone?: 'deploy' | 'error' | 'neutral' };
export type ChartFinding = { t: number; seriesId: string; label: string };
export type ChartThreshold = { value: number; tone: 'warning' | 'error'; label: string };
export type ChartBand = { from: number; to: number; label: string; tone?: 'warning' | 'error' };

export const CHART_TONES: Record<ChartTone, string> = {
	neutral: 'var(--neutral-9)',
	accent: 'var(--accent-7)',
	warning: 'var(--amber-7)',
	error: 'var(--red-7)',
	faint: 'var(--neutral-6)'
};

export const SERIES_COLORS = [
	'var(--blue-7)',
	'var(--neutral-10)',
	'var(--hue-pink)',
	'var(--blue-10)',
	'var(--hue-slate)',
	'var(--neutral-7)'
];

export function seriesColor(s: ChartSeries): string {
	return s.color ?? CHART_TONES[s.tone ?? 'neutral'];
}

export function nearestPoint(points: ChartPoint[], t: number): ChartPoint | null {
	if (!points.length) return null;
	let lo = 0;
	let hi = points.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (points[mid].x < t) lo = mid + 1;
		else hi = mid;
	}
	const a = points[Math.max(0, lo - 1)];
	const b = points[lo];
	return Math.abs(a.x - t) <= Math.abs(b.x - t) ? a : b;
}

export function valueAt(points: ChartPoint[], t: number, tolerance: number): number | null {
	const p = nearestPoint(points, t);
	return p && Math.abs(p.x - t) <= tolerance ? p.y : null;
}

export function seriesStats(points: ChartPoint[]) {
	if (!points.length) return null;
	let min = Infinity;
	let max = -Infinity;
	let sum = 0;
	for (const p of points) {
		if (p.y < min) min = p.y;
		if (p.y > max) max = p.y;
		sum += p.y;
	}
	return { avg: sum / points.length, min, max, last: points[points.length - 1].y };
}

export function chartTime(t: number, span: number, seconds = false): string {
	const d = new Date(t);
	const time = d.toLocaleTimeString(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		second: seconds ? '2-digit' : undefined,
		hour12: false
	});
	if (span <= 24 * 60 * 60_000) return time;
	return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}
