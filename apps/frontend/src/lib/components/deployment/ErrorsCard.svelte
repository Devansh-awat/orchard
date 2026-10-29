<script lang="ts">
	import { CircleCheck } from 'lucide-svelte';
	import { Button, SectionCard } from '$lib/components/ui';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import { apiFetch } from '$lib/stores';

	type ErrorGroup = {
		fingerprint: string;
		type: string;
		message: string;
		count: number;
		status: string;
		lastSeen: string;
	};

	let {
		deploymentId,
		onopen
	}: {
		deploymentId: string;
		onopen: () => void;
	} = $props();

	let groups = $state<ErrorGroup[] | null>(null);

	async function load(id: string) {
		try {
			const res = await apiFetch(`/apiv1/observe/deployments/${encodeURIComponent(id)}/errors`);
			if (!res.ok) return;
			const body = await res.json();
			groups = ((body?.errors ?? []) as ErrorGroup[])
				.filter((g) => g.status !== 'resolved' && g.status !== 'ignored')
				.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
		} catch {
			return;
		}
	}

	$effect(() => {
		const id = deploymentId;
		if (!id) return;
		load(id);
		const timer = setInterval(() => {
			if (!document.hidden) load(id);
		}, 60_000);
		return () => clearInterval(timer);
	});

	const total = $derived((groups ?? []).reduce((sum, g) => sum + g.count, 0));
</script>

<SectionCard title="Errors" size="sm" flush fill class="errors">
	{#snippet actions()}
		{#if groups?.length}
			<span class="total">{total.toLocaleString()} total</span>
		{/if}
		<Button variant="ghost" size="sm" onclick={onopen}>All errors</Button>
	{/snippet}
	{#if groups && groups.length === 0}
		<p class="clear"><CircleCheck size={16} aria-hidden="true" />No new errors</p>
	{:else if groups}
		<ul class="list">
			{#each groups.slice(0, 4) as g (g.fingerprint)}
				<li>
					<button type="button" class="err" onclick={onopen}>
						<span class="head">
							<span class="type">{g.type}</span>
							<span class="count">{g.count.toLocaleString()}×</span>
						</span>
						<span class="foot">
							<span class="msg">{g.message}</span>
							<span class="when"><RelativeTime date={g.lastSeen} /></span>
						</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</SectionCard>

<style>
	.total {
		font-size: var(--text-footnote);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.list {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li + li {
		box-shadow: inset 0 1px 0 var(--border-default);
	}
	.err {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		width: 100%;
		padding: 0.625rem 1.25rem;
		border: none;
		background: none;
		text-align: left;
		cursor: pointer;
	}
	.err:hover {
		background: var(--bg-hover);
	}
	.head,
	.foot {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		min-width: 0;
	}
	.type {
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: var(--text-footnote);
		font-weight: var(--weight-medium);
		color: var(--status-error);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.count {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: var(--text-footnote);
		color: var(--text-default);
		font-variant-numeric: tabular-nums;
	}
	.msg {
		overflow: hidden;
		font-size: var(--text-caption);
		color: var(--text-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.when {
		flex-shrink: 0;
		font-size: var(--text-caption);
		color: var(--text-faint);
	}
	.clear {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 1.25rem 1rem;
		font-size: var(--text-callout);
		color: var(--text-muted);
	}
	.clear :global(svg) {
		color: var(--status-success);
	}
</style>
