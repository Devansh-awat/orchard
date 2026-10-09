<script lang="ts">
	import { getContext } from 'svelte';
	import { ChevronRight } from 'lucide-svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import { getGreenhouseApp } from './app.svelte';
	import { usageView } from './machine-usage';
	import { UsagePoll, levelStatus } from './usage-live.svelte';
	import type { Sandbox } from '$lib/types/sandbox';

	let { machine, open, owner }: { machine: Sandbox; open: boolean; owner: boolean } = $props();

	const app = getGreenhouseApp();
	const menu = getContext<{ close: () => void } | undefined>('ui-menu');
	const poll = new UsagePoll();

	const view = $derived(poll.usage ? usageView(poll.usage, poll.now, owner) : null);
	const hidden = $derived(poll.failed && !poll.usage);

	const machineId = $derived(machine.id);
	const machineStatus = $derived(machine.status);

	$effect(() => {
		const id = machineId;
		void machineStatus;
		if (!open) return;
		return poll.watch(id);
	});

	function viewUsage() {
		app.openSettings('usage');
		menu?.close();
	}
</script>

{#if !hidden}
	<div class="usage" role="group" aria-label="Machine usage">
		{#if !view}
			<div class="meters" aria-hidden="true">
				{#each [0, 1, 2] as i (i)}
					<div class="meter">
						<div class="top">
							<Skeleton width="2.5rem" height="0.5rem" />
							<Skeleton width={i === 2 ? '4.5rem' : '3.5rem'} height="0.5rem" />
						</div>
						<Skeleton height="0.25rem" rounded="0.125rem" />
					</div>
				{/each}
			</div>
		{:else}
			{#if view.measured.length}
				<div class="meters">
					{#each view.measured as m (m.key)}
						{@const status = levelStatus(m.level)}
						<div class="meter">
							<div class="top">
								<span class="label">{m.label}</span>
								{#if status}
									{@const Icon = status.icon}
									<span class="level status--{status.kind}">
										<span class="level-glyph"><Icon size={12} strokeWidth={1.75} /></span>
										{status.label}
									</span>
								{/if}
								<span class="value">{m.value}</span>
							</div>
							<div
								class="bar"
								role="meter"
								aria-label={m.label}
								aria-valuemin={0}
								aria-valuemax={100}
								aria-valuenow={m.percent ?? 0}
								aria-valuetext={status ? `${m.value}, ${status.label}` : m.value}
							>
								<div
									class="fill"
									class:fill--warning={status?.kind === 'warning'}
									class:fill--error={status?.kind === 'error'}
									style:width="{Math.max((m.fraction ?? 0) * 100, 1.5)}%"
								></div>
							</div>
						</div>
					{/each}
				</div>
			{:else if !view.live && view.limits}
				<p class="line">{view.limits}</p>
			{/if}
			{#if view.time.length}
				<p class="line">{view.time.join(' · ')}</p>
			{/if}
			<div class="foot">
				<span class="foot-text">{view.footer ?? ''}</span>
				<button type="button" class="more" role="menuitem" onclick={viewUsage}>
					View usage
					<ChevronRight size={12} strokeWidth={1.75} />
				</button>
			</div>
		{/if}
	</div>
	<div class="gh-menu-sep"></div>
{/if}

<style>
	.usage {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: 0;
		min-width: 100%;
		padding: 0.25rem 0.5rem 0.25rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}

	.meters {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.meter {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		min-width: 0;
		min-height: var(--gh-lh-caption);
	}

	.label {
		flex: none;
		color: var(--gh-muted);
	}

	.value {
		min-width: 0;
		margin-left: auto;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--gh-text);
		font-variant-numeric: tabular-nums;
	}

	.level {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex: none;
		color: var(--gh-text);
		font-weight: 600;
		white-space: nowrap;
	}

	.level-glyph {
		display: inline-grid;
	}

	.status--warning .level-glyph {
		color: var(--status-warning);
	}

	.status--error .level-glyph {
		color: var(--status-error);
	}

	.bar {
		height: 0.25rem;
		border-radius: 0.125rem;
		background: var(--gh-hover);
		overflow: hidden;
	}

	.fill {
		height: 100%;
		border-radius: inherit;
		background: color-mix(in oklab, var(--gh-text) 45%, transparent);
	}

	.fill--warning {
		background: var(--status-warning);
	}

	.fill--error {
		background: var(--status-error);
	}

	.line {
		margin: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-variant-numeric: tabular-nums;
	}

	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		min-width: 0;
	}

	.foot-text {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--gh-faint);
		font-variant-numeric: tabular-nums;
	}

	.more {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex: none;
		height: 1.5rem;
		margin-right: -0.25rem;
		padding: 0 0.25rem 0 0.5rem;
		border-radius: var(--gh-r-control);
		color: var(--gh-muted-strong);
		transition:
			color var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}

	.more:hover,
	.more:focus-visible {
		color: var(--gh-text);
		background: var(--gh-hover);
	}

	.more:focus-visible {
		outline: 2px solid var(--gh-accent);
		outline-offset: -2px;
	}
</style>
