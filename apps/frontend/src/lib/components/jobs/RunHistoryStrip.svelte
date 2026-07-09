<script lang="ts">
	import { goto } from '$app/navigation';
	import type { RunStatus } from '$lib/types/jobs';

	let {
		runs,
		orgSlug,
		jobId,
		slots = 10
	}: {
		runs: { id: string; number: number; status: RunStatus }[];
		orgSlug: string;
		jobId: string;
		slots?: number;
	} = $props();

	const ordered = $derived([...runs].slice(0, slots).reverse());
	const empty = $derived(Math.max(0, slots - ordered.length));

	function toneOf(status: RunStatus): string {
		if (status === 'succeeded') return 'ok';
		if (status === 'failed' || status === 'timed_out') return 'fail';
		if (status === 'running' || status === 'pending') return 'live';
		return 'muted';
	}
</script>

<div class="job-history-strip" role="list" aria-label="Recent runs">
	{#each Array(empty) as _, i (i)}
		<span class="job-history-bar job-history-bar--empty"></span>
	{/each}
	{#each ordered as run, i (run.id)}
		<button
			type="button"
			role="listitem"
			class="job-history-bar job-history-bar--{toneOf(run.status)}"
			style="animation-delay: {i * 35}ms"
			title="#{run.number} · {run.status}"
			onclick={(e) => {
				e.stopPropagation();
				goto(`/${orgSlug}/jobs/${jobId}/runs/${run.id}`);
			}}
		></button>
	{/each}
</div>
