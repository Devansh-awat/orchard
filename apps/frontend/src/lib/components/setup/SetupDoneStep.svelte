<script lang="ts">
	import { telemetry } from '$lib/stores';
	import { presence } from '$lib/utils/transitions';
	import SettingCommand from './SettingCommand.svelte';
	import { settingChanges, type SettingChange, type SettingChanges } from './setting-changes';
	import type { SetupOverview, SetupOverviewItem } from './setup-overview';

	let {
		overview,
		onDone
	}: {
		overview: SetupOverview | null;
		onDone: (href?: string) => Promise<void> | void;
	} = $props();

	const items = $derived(overview?.items ?? []);
	const changes = $derived(settingChanges(overview));
	const email = $derived<SetupOverviewItem | null>(
		changes.letsencrypt
			? {
					id: 'letsencrypt',
					title: changes.letsencrypt.title,
					value: 'On the server',
					state: 'configured',
					detail: null,
					href: '/admin/networking'
				}
			: null
	);
	const opened = $state<Record<string, boolean>>({});

	function changeFor(item: SetupOverviewItem): SettingChange | undefined {
		if (item.id === 'mcp' && overview?.mcp.deployed && !overview.mcp.enabled) return undefined;
		return changes[item.id as keyof SettingChanges];
	}

	function change(item: SetupOverviewItem) {
		if (changeFor(item)) {
			opened[item.id] = !opened[item.id];
			return;
		}
		onDone(item.href);
	}

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
	const all = $derived([...items, ...(email ? [email] : []), ...(reports ? [reports] : [])]);
	const ready = $derived(all.filter((item) => item.state === 'configured'));
	const open = $derived(all.filter((item) => item.state !== 'configured'));
</script>

{#snippet command(item: SetupOverviewItem)}
	{@const setting = changeFor(item)}
	{#if setting && opened[item.id]}
		<div class="command" in:presence out:presence>
			<SettingCommand change={setting} />
		</div>
	{/if}
{/snippet}

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
							<button
								class="change"
								aria-expanded={changeFor(item) ? !!opened[item.id] : undefined}
								onclick={() => change(item)}>Change</button
							>
						</div>
						{#if item.detail}
							<p class="detail">{item.detail}</p>
						{/if}
						{@render command(item)}
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
							<button
								class="change"
								aria-expanded={changeFor(item) ? !!opened[item.id] : undefined}
								onclick={() => change(item)}>Change</button
							>
						</div>
						{@render command(item)}
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

	.command {
		--change-ink: var(--setup-ink-faint);
		--change-ink-strong: var(--setup-ink-soft);
		padding-top: 0.45rem;
	}

	.setup-step p.detail {
		max-width: none;
		margin: 0.15rem 0 0;
		font-size: 0.75rem;
		line-height: 1.4;
		color: var(--setup-ink-faint);
	}
</style>
