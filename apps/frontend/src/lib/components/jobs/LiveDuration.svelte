<script lang="ts">
	import { onDestroy } from 'svelte';

	let {
		startedAt,
		finishedAt = null
	}: {
		startedAt: string | null;
		finishedAt?: string | null;
	} = $props();

	let now = $state(Date.now());
	let timer: ReturnType<typeof setInterval> | null = null;

	$effect(() => {
		const live = !!startedAt && !finishedAt;
		if (live && !timer) {
			timer = setInterval(() => (now = Date.now()), 1000);
		} else if (!live && timer) {
			clearInterval(timer);
			timer = null;
		}
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
	});

	const label = $derived.by(() => {
		if (!startedAt) return null;
		const end = finishedAt ? new Date(finishedAt).getTime() : now;
		const s = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000));
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ${s % 60}s`;
		return `${Math.floor(m / 60)}h ${m % 60}m`;
	});
</script>

{#if label}
	<span class="job-duration" class:job-duration--live={startedAt && !finishedAt}>{label}</span>
{/if}
