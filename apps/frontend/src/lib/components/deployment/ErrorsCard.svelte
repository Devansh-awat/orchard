<script lang="ts">
	import { CircleCheck } from 'lucide-svelte';
	import { Button, SectionCard } from '$lib/components/ui';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import Sparkline from '$lib/components/ui/Sparkline.svelte';
	import NumberRoll from '$lib/components/ui/NumberRoll.svelte';
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
	let rates = $state<number[]>([]);

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

	async function loadRate(id: string) {
		const end = Date.now();
		try {
			const res = await apiFetch(
				`/apiv1/observe/deployments/${encodeURIComponent(id)}/http-metrics?start=${end - 30 * 60_000}&end=${end}&step=60000`
			);
			if (!res.ok) return;
			const body = await res.json();
			rates = ((body?.errorRate ?? []) as { y: number }[]).map((p) => p.y);
		} catch {
			return;
		}
	}

	$effect(() => {
		const id = deploymentId;
		if (!id) return;
		load(id);
		loadRate(id);
		const timer = setInterval(() => {
			if (document.hidden) return;
			load(id);
			loadRate(id);
		}, 60_000);
		return () => clearInterval(timer);
	});

	const rate = $derived(rates.length ? rates[rates.length - 1] : null);
	const tone = $derived(
		rate == null ? 'neutral' : rate >= 5 ? 'error' : rate >= 1 ? 'warning' : 'neutral'
	);
</script>

<SectionCard title="Errors" size="sm" flush fill class="errors">
	{#snippet actions()}
		<Button variant="ghost" size="sm" onclick={onopen}>All errors</Button>
	{/snippet}
	{#if rate != null}
		<div class="rate rate--{tone}">
			<span class="rate-label">Error rate</span>
			<span class="rate-value"><NumberRoll value={rate.toFixed(2)} />%</span>
			<span class="rate-of">of requests</span>
			<span class="rate-trend">
				<Sparkline values={rates} height={24} {tone} label="Error rate over the last 30 minutes" />
			</span>
		</div>
	{/if}
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
	.rate {
		display: grid;
		grid-template-columns: 4rem auto minmax(0, 1fr) 5rem;
		align-items: center;
		column-gap: 0.75rem;
		padding: 0.625rem 1.25rem;
		box-shadow: inset 0 -1px 0 var(--border-default);
	}
	.rate-label {
		font-size: var(--text-footnote);
		color: var(--text-muted);
		white-space: nowrap;
	}
	.rate-value {
		display: inline-flex;
		align-items: baseline;
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: var(--weight-semibold);
		font-variant-numeric: tabular-nums;
		color: var(--text-default);
	}
	.rate--warning .rate-value {
		color: var(--status-warning);
	}
	.rate--error .rate-value {
		color: var(--status-error);
	}
	.rate-of {
		font-size: var(--text-caption);
		color: var(--text-muted);
	}
	.rate-trend {
		min-width: 0;
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
