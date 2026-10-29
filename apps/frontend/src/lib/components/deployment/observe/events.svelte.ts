import { apiFetch } from '$lib/stores';
import { DEMO_KILLED_LOGS, demoKilled } from '$lib/utils/observe-demo';

export type PodEvent = {
	type?: string;
	reason?: string;
	message?: string;
	count?: number;
	firstTimestamp?: string;
	lastTimestamp?: string;
};

export type KilledContainer = {
	entryId: string;
	pod: string;
	container: string;
	reason: string;
	exitCode: number | null;
	finishedAt: string | null;
	capturedAt: string;
};

export type TimelineItem =
	| { kind: 'killed'; key: string; at: number; item: KilledContainer }
	| { kind: 'warning'; key: string; at: number; item: PodEvent & { pod: string } };

const time = (s?: string | null) => (s ? new Date(s).getTime() || 0 : 0);

export class EventsState {
	killed = $state<KilledContainer[]>([]);
	warnings = $state<(PodEvent & { pod: string })[]>([]);
	loaded = $state(false);
	loading = $state(false);
	error = $state<string | null>(null);
	captured = $state<Record<string, string>>({});
	capturing = $state<string | null>(null);

	items = $derived<TimelineItem[]>(
		[
			...this.killed.map((k) => ({
				kind: 'killed' as const,
				key: `killed:${k.entryId}`,
				at: time(k.finishedAt ?? k.capturedAt),
				item: k
			})),
			...this.warnings.map((w, i) => ({
				kind: 'warning' as const,
				key: `warning:${w.pod}:${w.reason}:${w.firstTimestamp ?? i}`,
				at: time(w.lastTimestamp ?? w.firstTimestamp),
				item: w
			}))
		].sort((a, b) => b.at - a.at)
	);

	#seq = 0;

	async fetch(id: string, opts: { demo: boolean; pods: { name?: string; events?: PodEvent[] }[] }) {
		const seq = ++this.#seq;
		const flatten = (pods: { name?: string; events?: PodEvent[] }[]) =>
			pods.flatMap((p) => (p.events ?? []).map((e) => ({ ...e, pod: p.name ?? 'unknown' })));
		if (opts.demo) {
			this.killed = demoKilled();
			this.warnings = flatten(opts.pods);
			this.error = null;
			this.loaded = true;
			return;
		}
		this.loading = true;
		try {
			const [killedRes, podsRes] = await Promise.all([
				apiFetch(`/apiv1/deployments/${id}/killed-containers`),
				apiFetch(`/apiv1/deployments/${id}/pods-live`)
			]);
			if (seq !== this.#seq) return;
			if (!killedRes.ok) throw new Error(`HTTP ${killedRes.status}`);
			if (!podsRes.ok) throw new Error(`HTTP ${podsRes.status}`);
			const [killed, live] = await Promise.all([killedRes.json(), podsRes.json()]);
			if (seq !== this.#seq) return;
			this.killed = killed ?? [];
			this.warnings = flatten(live?.pods ?? []);
			this.error = null;
			this.loaded = true;
		} catch (err) {
			if (seq === this.#seq) this.error = (err as Error).message;
		} finally {
			if (seq === this.#seq) this.loading = false;
		}
	}

	async capture(id: string, entryId: string, demo: boolean) {
		if (this.captured[entryId] !== undefined) return;
		if (demo) {
			this.captured = { ...this.captured, [entryId]: DEMO_KILLED_LOGS[entryId] ?? '' };
			return;
		}
		this.capturing = entryId;
		try {
			const res = await apiFetch(
				`/apiv1/deployments/${id}/killed-containers/${encodeURIComponent(entryId)}/logs`
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			this.captured = { ...this.captured, [entryId]: data.logs || '' };
		} catch {
			this.captured = { ...this.captured, [entryId]: '' };
		} finally {
			this.capturing = null;
		}
	}
}
