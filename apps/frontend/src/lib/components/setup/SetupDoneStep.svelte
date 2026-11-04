<script lang="ts">
	import { telemetry } from '$lib/stores';
	import type { SetupOverviewItem } from './setup-overview';

	let {
		items,
		onDone
	}: {
		items: SetupOverviewItem[];
		onDone: (href?: string) => Promise<void> | void;
	} = $props();

	const url = $derived(typeof window === 'undefined' ? '' : window.location.origin);
	const reports = $derived<SetupOverviewItem | null>(
		$telemetry
			? {
					id: 'telemetry',
					title: 'Usage reports',
					value: $telemetry.enabled ? 'On' : 'Off',
					state: $telemetry.enabled ? 'configured' : 'off',
					detail: null,
					href: '/admin/instance'
				}
			: null
	);
	const all = $derived(reports ? [...items, reports] : items);
	const ready = $derived(all.filter((item) => item.state === 'configured'));
	const open = $derived(all.filter((item) => item.state !== 'configured'));
</script>

<section class="setup-step">
	<h2>You're set</h2>

	<div class="setup-body">
		<div class="setup-url">{url}</div>

		{#if open.length > 0}
			<h3>Skipped or not set</h3>
			<ul>
				{#each open as item (item.id)}
					<li>
						<div class="row">
							<span class="name">{item.title}</span>
							<span class="state">{item.state === 'skipped' ? 'Skipped' : item.value}</span>
							<button class="change" onclick={() => onDone(item.href)}>Change</button>
						</div>
						{#if item.detail}
							<p class="detail">{item.detail}</p>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if ready.length > 0}
			<h3>Configured</h3>
			<ul>
				{#each ready as item (item.id)}
					<li>
						<div class="row">
							<span class="name">{item.title}</span>
							<span class="state">{item.value}</span>
							<button class="change" onclick={() => onDone(item.href)}>Change</button>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<div class="setup-acts">
		<button class="setup-pill" onclick={() => onDone()}>Go to Orchard</button>
	</div>
</section>

<style>
	h3 {
		margin: 1.2rem 0 0.35rem;
		text-align: left;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--setup-ink-faint);
	}

	ul {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
		text-align: left;
	}

	li {
		padding: 0.42rem 0;
		border-top: 1px solid var(--setup-line);
	}

	.row {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		font-size: 0.8125rem;
		line-height: 1.4;
	}

	.name {
		flex: none;
		font-weight: 500;
		color: var(--setup-ink);
	}

	.state {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-align: right;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--setup-ink-soft);
	}

	.change {
		flex: none;
		border: 0;
		background: none;
		padding: 0;
		cursor: pointer;
		font: inherit;
		font-weight: 500;
		color: var(--setup-crimson);
	}

	.change:focus-visible {
		outline: 2px solid var(--setup-crimson);
		outline-offset: 2px;
		border-radius: 0.25rem;
	}

	.setup-step p.detail {
		max-width: none;
		margin: 0.15rem 0 0;
		font-size: 0.75rem;
		line-height: 1.4;
		color: var(--setup-ink-faint);
	}
</style>
