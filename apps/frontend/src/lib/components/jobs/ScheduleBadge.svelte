<script lang="ts">
	import { CalendarClock, Hand, Pause } from 'lucide-svelte';
	import { describeCron } from '$lib/utils/cron';

	let {
		scheduleCron,
		timeZone = null,
		enabled = true
	}: {
		scheduleCron: string | null;
		timeZone?: string | null;
		enabled?: boolean;
	} = $props();

	const label = $derived(scheduleCron ? describeCron(scheduleCron, timeZone) : 'Manual only');
</script>

<span class="job-schedule-badge" class:job-schedule-badge--paused={scheduleCron && !enabled}>
	{#if !scheduleCron}
		<Hand size={12} />
	{:else if enabled}
		<CalendarClock size={12} />
	{:else}
		<Pause size={12} />
	{/if}
	{label}{#if scheduleCron && !enabled}&nbsp;· paused{/if}
</span>
