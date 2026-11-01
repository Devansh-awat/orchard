import { onMount } from 'svelte';
import { get } from 'svelte/store';
import { subscribeOrgEvents, selectedOrganization } from '$lib/stores';
import { fetchAnomalies, type Anomaly, type AnomalyScope } from './anomalies';

const LIVE_EVENTS = new Set(['deployment.changed', 'pod.changed', 'database.changed']);

export function anomalyFeed(
	scope: () => AnomalyScope,
	kinds: () => readonly string[] | null = () => null
) {
	let items = $state<Anomaly[]>([]);
	let loaded = $state(false);
	let inflight = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	async function load() {
		if (inflight) return;
		inflight = true;
		try {
			const all = await fetchAnomalies(scope());
			const only = kinds();
			items = only ? all.filter((a) => only.includes(a.kind)) : all;
			loaded = true;
		} catch {
		} finally {
			inflight = false;
		}
	}

	function scheduleLoad() {
		if (timer) return;
		timer = setTimeout(() => {
			timer = null;
			void load();
		}, 600);
	}

	$effect(() => {
		const s = scope();
		void s.id;
		void s.kind;
		void load();
	});

	onMount(() => {
		const orgId = get(selectedOrganization)?.id;
		const unsub = orgId
			? subscribeOrgEvents(orgId, (ev) => {
					if (LIVE_EVENTS.has(ev.type)) scheduleLoad();
				})
			: () => {};
		const interval = setInterval(() => {
			if (!document.hidden) void load();
		}, 60_000);
		return () => {
			unsub();
			clearInterval(interval);
			if (timer) clearTimeout(timer);
		};
	});

	return {
		get items() {
			return items;
		},
		get loaded() {
			return loaded;
		}
	};
}
