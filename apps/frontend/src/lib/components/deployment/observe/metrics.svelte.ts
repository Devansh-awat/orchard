import { apiFetch } from '$lib/stores';
import {
	demoHttpMetrics,
	demoResourceSeries,
	demoResourceSeriesByPod
} from '$lib/utils/observe-demo';
import type { ChartDisplay, ChartEvent, ChartPoint } from '$lib/components/ui/time-chart';
import { podLabel } from '$lib/utils/format';
import { demoErrors, demoKilled } from '$lib/utils/observe-demo';
import type { KilledContainer, PodEvent } from './events.svelte';
import type { ErrorGroup } from './errors.svelte';
import type { LogEntry } from './logs.svelte';

export type Release = {
	at: number;
	tag: string;
	title: string;
	status: string;
	startedAt: number | null;
	completedAt: number | null;
};

export type MetricId = 'req' | 'err' | 'lat' | 'cpu' | 'mem' | 'rx' | 'tx';
export type ChartId = 'req' | 'err' | 'lat' | 'cpu' | 'mem' | 'net';
export type ChartMode = ChartDisplay | 'top';
export type ResourceId = 'cpu' | 'mem' | 'rx' | 'tx';
export type PodSeries = { key: string; points: ChartPoint[] };

export const RANGES = [
	{ id: '5m', label: 'Last 5 minutes', short: 'Last 5m', ms: 5 * 60_000 },
	{ id: '15m', label: 'Last 15 minutes', short: 'Last 15m', ms: 15 * 60_000 },
	{ id: '30m', label: 'Last 30 minutes', short: 'Last 30m', ms: 30 * 60_000 },
	{ id: '1h', label: 'Last hour', short: 'Last 1h', ms: 60 * 60_000 },
	{ id: '6h', label: 'Last 6 hours', short: 'Last 6h', ms: 6 * 60 * 60_000 },
	{ id: '24h', label: 'Last 24 hours', short: 'Last 24h', ms: 24 * 60 * 60_000 },
	{ id: '7d', label: 'Last 7 days', short: 'Last 7d', ms: 7 * 24 * 60 * 60_000 }
] as const;

export function stepFor(ms: number): number {
	if (ms <= 30 * 60_000) return 15_000;
	if (ms <= 60 * 60_000) return 30_000;
	if (ms <= 6 * 60 * 60_000) return 60_000;
	if (ms <= 24 * 60 * 60_000) return 5 * 60_000;
	return 30 * 60_000;
}

const EMPTY_RESOURCES = (): Record<ResourceId, ChartPoint[]> => ({
	cpu: [],
	mem: [],
	rx: [],
	tx: []
});
const EMPTY_PODS = (): Record<ResourceId, PodSeries[]> => ({ cpu: [], mem: [], rx: [], tx: [] });
const EMPTY_HTTP = () => ({
	req: [] as ChartPoint[],
	err: [] as ChartPoint[],
	lat: [] as ChartPoint[],
	latmax: [] as ChartPoint[]
});

function merge(groups: PodSeries[] | undefined): ChartPoint[] {
	if (!groups?.length) return [];
	const acc = new Map<number, number>();
	for (const g of groups) for (const p of g.points) acc.set(p.x, (acc.get(p.x) ?? 0) + p.y);
	return [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y }));
}

export class MetricsState {
	windowMs = $state(60 * 60_000);
	custom = $state<{ from: number; to: number } | null>(null);
	paused = $state(false);
	byPod = $state(false);
	now = $state(Date.now());
	hover = $state<number | null>(null);
	modes = $state<Partial<Record<ChartId, ChartMode>>>({});
	killed = $state<KilledContainer[]>([]);
	warnings = $state<(PodEvent & { pod: string })[]>([]);
	releases = $state<Release[]>([]);
	errorGroups = $state<ErrorGroup[]>([]);
	logTail = $state<LogEntry[]>([]);

	events = $derived<ChartEvent[]>([
		...this.releases
			.filter((r) => r.status === 'succeeded')
			.map((r) => ({
				t: r.at,
				label: `deploy ${r.tag}${r.title ? ` (${r.title})` : ''}`,
				tone: 'deploy' as const
			})),
		...this.killed.flatMap((k) =>
			k.finishedAt
				? [
						{
							t: new Date(k.finishedAt).getTime(),
							label: `${podLabel(k.pod)} ${k.reason === 'OOMKilled' ? 'ran out of memory' : `stopped (${k.reason})`}`,
							tone: 'error' as const
						}
					]
				: []
		)
	]);

	resources = $state(EMPTY_RESOURCES());
	pods = $state(EMPTY_PODS());
	http = $state(EMPTY_HTTP());
	loaded = $state(false);
	loading = $state(false);
	error = $state<string | null>(null);

	to = $derived(this.custom?.to ?? this.now);
	from = $derived(this.custom?.from ?? this.to - this.windowMs);
	step = $derived(stepFor(this.to - this.from));
	live = $derived(!this.paused && !this.custom);

	#seq = 0;

	setRange(ms: number) {
		this.windowMs = ms;
		this.custom = null;
		this.now = Date.now();
	}

	zoom(from: number, to: number) {
		this.custom = { from: Math.round(from), to: Math.round(to) };
	}

	clearCustom() {
		this.custom = null;
		this.now = Date.now();
	}

	togglePause() {
		if (this.custom) {
			this.clearCustom();
			this.paused = false;
			return;
		}
		this.paused = !this.paused;
		if (!this.paused) this.now = Date.now();
	}

	tick() {
		this.now = Date.now();
	}

	shift(direction: -1 | 1) {
		const span = this.to - this.from;
		const now = Date.now();
		const to = Math.min(now, this.to + direction * span);
		if (direction > 0 && to >= now - this.step) {
			this.windowMs = span;
			this.clearCustom();
			return;
		}
		this.custom = { from: to - span, to };
	}

	zoomOut() {
		const span = this.to - this.from;
		const now = Date.now();
		const mid = (this.from + this.to) / 2;
		const to = Math.min(now, mid + span);
		if (to >= now - this.step) {
			this.windowMs = Math.min(span * 2, 7 * 24 * 60 * 60_000);
			this.clearCustom();
			return;
		}
		this.custom = { from: to - span * 2, to };
	}

	async loadContext(
		id: string,
		opts: { demo: boolean; pods: { name?: string; events?: PodEvent[] }[] }
	) {
		const flatten = (pods: { name?: string; events?: PodEvent[] }[]) =>
			pods.flatMap((p) => (p.events ?? []).map((e) => ({ ...e, pod: p.name ?? 'unknown' })));
		const minutes = Math.max(15, Math.round((this.to - this.from) / 60_000));
		if (opts.demo) {
			this.killed = demoKilled();
			this.warnings = flatten(opts.pods);
			this.errorGroups = demoErrors(minutes) as ErrorGroup[];
			return;
		}
		const get = (url: string) =>
			apiFetch(url)
				.then((r) => (r.ok ? r.json() : null))
				.catch(() => null);
		const base = `/apiv1/observe/deployments/${encodeURIComponent(id)}`;
		const [timeline, killed, live, errors, logs] = await Promise.all([
			get(`${base}/timeline?kinds=release,build&limit=60`),
			get(`/apiv1/deployments/${encodeURIComponent(id)}/killed-containers`),
			get(`/apiv1/deployments/${encodeURIComponent(id)}/pods-live`),
			get(`${base}/errors?window=${minutes}`),
			get(`${base}/logs/structured?tailLines=2000`)
		]);
		const time = (v: unknown) => (v ? new Date(v as string).getTime() || null : null);
		this.releases = ((timeline?.entries ?? []) as any[]).flatMap((e) => {
			const at = time(e.at);
			return at
				? [
						{
							at,
							tag: e.meta?.tag ?? '',
							title: e.title ?? '',
							status: e.meta?.buildStatus ?? e.status ?? '',
							startedAt: time(e.meta?.buildStartedAt),
							completedAt: time(e.meta?.buildCompletedAt)
						}
					]
				: [];
		});
		this.killed = Array.isArray(killed) ? killed : [];
		this.warnings = flatten(live?.pods ?? []);
		this.errorGroups = errors?.errors ?? [];
		const entries: LogEntry[] = logs?.entries ?? [];
		this.logTail = entries;
	}

	async load(id: string, opts: { http: boolean; demo: boolean }) {
		const { from, to, step, byPod } = this;
		const seq = ++this.#seq;
		if (opts.demo) {
			const g = demoResourceSeriesByPod(from, to, step);
			this.pods = g;
			this.resources = byPod
				? { cpu: merge(g.cpu), mem: merge(g.mem), rx: merge(g.rx), tx: merge(g.tx) }
				: demoResourceSeries(from, to, step);
			const h = demoHttpMetrics(from, to, step);
			this.http = { req: h.requestRate, err: h.errorRate, lat: h.latencyAvg, latmax: h.latencyMax };
			this.error = null;
			this.loaded = true;
			return;
		}
		if (!this.loaded) this.loading = true;
		const query = `start=${from}&end=${to}&step=${step}`;
		try {
			const [res, httpRes] = await Promise.all([
				apiFetch(`/apiv1/deployments/${encodeURIComponent(id)}/metrics?${query}&groupBy=pod`),
				opts.http
					? apiFetch(`/apiv1/observe/deployments/${encodeURIComponent(id)}/http-metrics?${query}`)
					: Promise.resolve(null)
			]);
			if (seq !== this.#seq) return;
			if (!res.ok) {
				const detail = await res.json().catch(() => null);
				throw new Error(
					res.status === 503
						? 'The metrics store is unreachable'
						: (detail?.message ?? `HTTP ${res.status}`)
				);
			}
			const body = await res.json();
			if (seq !== this.#seq) return;
			if (body?.groupBy === 'pod' && body?.grouped) {
				this.pods = body.grouped;
				this.resources = {
					cpu: merge(body.grouped.cpu),
					mem: merge(body.grouped.mem),
					rx: merge(body.grouped.rx),
					tx: merge(body.grouped.tx)
				};
			} else {
				this.pods = EMPTY_PODS();
				this.resources = { ...EMPTY_RESOURCES(), ...(body?.data ?? {}) };
			}
			if (httpRes?.ok) {
				const h = await httpRes.json();
				if (seq !== this.#seq) return;
				this.http = {
					req: h?.requestRate ?? [],
					err: h?.errorRate ?? [],
					lat: h?.latencyAvg ?? [],
					latmax: h?.latencyMax ?? []
				};
			}
			this.error = null;
			this.loaded = true;
		} catch (err) {
			if (seq !== this.#seq) return;
			this.error = (err as Error).message;
		} finally {
			if (seq === this.#seq) this.loading = false;
		}
	}
}
