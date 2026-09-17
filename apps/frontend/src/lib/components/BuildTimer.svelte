<script module lang="ts">
	// Single shared clock for every mounted <BuildTimer>. The interval only runs
	// while at least one timer is on-screen, and `now` is module-scoped so
	// per-second updates invalidate only this component's effect — not the
	// caller's entire page tree.
	let now = $state(Date.now());
	let subs = 0;
	let timer: ReturnType<typeof setInterval> | null = null;

	function subscribe() {
		subs++;
		if (!timer) timer = setInterval(() => (now = Date.now()), 1000);
		return () => {
			subs--;
			if (subs === 0 && timer) {
				clearInterval(timer);
				timer = null;
			}
		};
	}

	export function getNow() {
		return now;
	}

	export { subscribe };
</script>

<script lang="ts">
	import { Timer } from 'lucide-svelte';

	let { startedAt }: { startedAt: string } = $props();

	$effect(() => subscribe());

	function fmt(s: number): string {
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
	}

	const elapsed = $derived(
		Math.max(0, Math.floor((getNow() - new Date(startedAt).getTime()) / 1000))
	);
</script>

<Timer size={10} />
{fmt(elapsed)}
