<script lang="ts">
	import { Check, X, Minus } from 'lucide-svelte';
	import { springPop } from '$lib/utils/motion.svelte';
	import type { RunStatus } from '$lib/types/jobs';

	let {
		status = null,
		number,
		size = 22
	}: {
		status?: RunStatus | null;
		number: number;
		size?: number;
	} = $props();

	const kind = $derived.by(() => {
		if (!status || status === 'pending') return 'pending';
		if (status === 'running') return 'running';
		if (status === 'succeeded') return 'succeeded';
		if (status === 'skipped' || status === 'canceled') return 'skipped';
		return 'failed';
	});
</script>

<span
	class="job-ring job-ring--{kind}"
	style="width: {size}px; height: {size}px;"
	aria-label={status ?? 'step'}
	{@attach springPop(() => kind === 'succeeded' || kind === 'failed')}
>
	{#if kind === 'succeeded'}
		<Check size={size * 0.55} strokeWidth={3} />
	{:else if kind === 'failed'}
		<X size={size * 0.55} strokeWidth={3} />
	{:else if kind === 'skipped'}
		<Minus size={size * 0.55} strokeWidth={3} />
	{:else}
		<span class="job-ring-number">{number}</span>
		{#if kind === 'running'}
			<span class="job-ring-spinner" style="width: {size}px; height: {size}px;"></span>
		{/if}
	{/if}
</span>
