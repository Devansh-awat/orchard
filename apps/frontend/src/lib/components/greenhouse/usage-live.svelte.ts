import { apiFetch } from '$lib/stores';
import { statusMeta, type StatusMeta } from '$lib/components/ui/status';
import { clock } from '$lib/utils/clock.svelte';
import { USAGE_POLL_MS, type MachineUsage, type UsageLevel } from './machine-usage';

export async function fetchMachineUsage(sandboxId: string): Promise<MachineUsage | null> {
	try {
		const res = await apiFetch(`/apiv1/sandboxes/${encodeURIComponent(sandboxId)}/usage`);
		return res.ok ? ((await res.json()) as MachineUsage) : null;
	} catch {
		return null;
	}
}

export function levelStatus(level: UsageLevel | null): StatusMeta | null {
	if (level === 'full') return statusMeta('error', 'At limit');
	if (level === 'near') return statusMeta('warning', 'Near limit');
	return null;
}

export class UsagePoll {
	usage = $state.raw<MachineUsage | null>(null);
	failed = $state(false);
	#skew = $state(0);
	#machine: string | null = null;

	readonly now = $derived(clock.now + this.#skew);

	watch(machineId: string): () => void {
		if (this.#machine !== machineId) {
			this.#machine = machineId;
			this.usage = null;
			this.failed = false;
		}
		let cancelled = false;
		let inflight = false;
		const load = async () => {
			if (inflight || (typeof document !== 'undefined' && document.hidden)) return;
			inflight = true;
			const next = await fetchMachineUsage(machineId);
			inflight = false;
			if (cancelled) return;
			if (next) {
				this.usage = next;
				this.failed = false;
				const server = Date.parse(next.fetchedAt);
				this.#skew = Number.isFinite(server) ? server - Date.now() : 0;
			} else {
				this.failed = true;
			}
		};
		const onVisible = () => {
			if (!document.hidden) void load();
		};
		void load();
		const timer = setInterval(load, USAGE_POLL_MS);
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			cancelled = true;
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	}
}
