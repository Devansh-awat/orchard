<script lang="ts">
	import { ArrowDownUp, Clock, Cpu, HardDrive, MemoryStick, Moon, Server } from 'lucide-svelte';
	import EmptyState from '@orchard/graft-ui/components/ui/EmptyState.svelte';
	import Skeleton from '@orchard/graft-ui/components/ui/Skeleton.svelte';
	import { usageView, type ResourceKey } from './machine-usage';
	import { UsagePoll, levelStatus } from './usage-live.svelte';
	import type { Sandbox } from '../../lib/types/sandbox';

	let { machine, owner }: { machine: Sandbox; owner: boolean } = $props();

	const ICONS: Record<ResourceKey, typeof Cpu> = { cpu: Cpu, memory: MemoryStick, disk: HardDrive };
	const PENDING = ['creating', 'starting'];

	const poll = new UsagePoll();
	const view = $derived(poll.usage ? usageView(poll.usage, poll.now, owner) : null);
	const waiting = $derived(PENDING.includes(machine.status));

	const machineId = $derived(machine.id);
	const machineStatus = $derived(machine.status);

	$effect(() => {
		const id = machineId;
		void machineStatus;
		return poll.watch(id);
	});
</script>

<section class="panel" aria-label="Machine usage" aria-busy={!view && !poll.failed}>
	{#if !view && poll.failed}
		<EmptyState
			title="Usage is unavailable right now"
			description="Orchard will try again in a few seconds."
		/>
	{:else if !view}
		<div class="resources" aria-hidden="true">
			{#each [0, 1, 2] as i (i)}
				<div class="tile">
					<Skeleton width="4rem" height="0.75rem" />
					<Skeleton width="7rem" height="1rem" />
					<Skeleton height="0.25rem" rounded="0.125rem" />
					<Skeleton width="5rem" height="0.625rem" />
				</div>
			{/each}
		</div>
		<div class="tile facts" aria-hidden="true">
			{#each [0, 1, 2] as i (i)}
				<div class="fact">
					<Skeleton width="4rem" height="0.75rem" />
					<Skeleton width="6rem" height="0.75rem" />
				</div>
			{/each}
		</div>
	{:else}
		{#if view.live}
			<div class="resources">
				{#each view.meters as m (m.key)}
					{@const status = levelStatus(m.level)}
					{@const Icon = ICONS[m.key]}
					<div class="tile">
						<div class="head">
							<span class="glyph"><Icon size={16} strokeWidth={1.75} /></span>
							<span class="title">{m.label}</span>
							{#if status}
								{@const LevelIcon = status.icon}
								<span class="level status--{status.kind}">
									<span class="level-glyph"><LevelIcon size={12} strokeWidth={1.75} /></span>
									{status.label}
								</span>
							{/if}
						</div>
						<p class="amount">
							{#if m.used !== null}
								<span class="used">{m.used}</span>
								<span class="of">/ {m.total} {m.unit}</span>
								<span class="pct">({m.percent}%)</span>
							{:else}
								<span class="of">{m.total} {m.unit}</span>
							{/if}
						</p>
						<div
							class="bar"
							role="meter"
							aria-label={m.label}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={m.percent ?? 0}
							aria-valuetext={m.used === null
								? `${m.value}, not measured yet`
								: status
									? `${m.value}, ${status.label}`
									: m.value}
						>
							{#if m.fraction !== null}
								<div
									class="fill"
									class:fill--warning={status?.kind === 'warning'}
									class:fill--error={status?.kind === 'error'}
									style:width="{Math.max(m.fraction * 100, 1)}%"
								></div>
							{/if}
						</div>
						<p class="caption">{m.used === null ? 'No reading yet' : m.caption}</p>
					</div>
				{/each}
			</div>
		{:else}
			<EmptyState
				title={waiting
					? 'Live usage appears once the machine is running'
					: 'Start the machine to see live usage'}
				description={view.limits ?? undefined}
			>
				{#snippet icon()}<Moon size={20} strokeWidth={1.75} />{/snippet}
			</EmptyState>
		{/if}

		<div class="tile facts">
			<div class="fact">
				<div class="head">
					<span class="glyph"><Clock size={16} strokeWidth={1.75} /></span>
					<span class="title">Runtime</span>
				</div>
				<p class="primary">{view.live && view.runtime.up ? view.runtime.up : 'Not running'}</p>
				{#if view.live && view.runtime.since}<p class="caption">{view.runtime.since}</p>{/if}
				<p class="caption">{view.runtime.sleep}</p>
				{#if view.live && view.runtime.sleepDetail}
					<p class="caption">{view.runtime.sleepDetail}</p>
				{/if}
				{#if view.runtime.lifetime}<p class="caption">{view.runtime.lifetime}</p>{/if}
			</div>
			{#if view.network || poll.usage?.runner === 'vercel'}
				<div class="fact">
					<div class="head">
						<span class="glyph"><ArrowDownUp size={16} strokeWidth={1.75} /></span>
						<span class="title">Network</span>
					</div>
					{#if view.network}
						<p class="primary num">{view.network.summary}</p>
						<p class="caption">This session</p>
						{#if view.network.total}<p class="caption num">{view.network.total}</p>{/if}
					{:else}
						<p class="primary muted">{view.live ? 'Not measured yet' : 'Not running'}</p>
					{/if}
				</div>
			{/if}
			<div class="fact">
				<div class="head">
					<span class="glyph"><Server size={16} strokeWidth={1.75} /></span>
					<span class="title">Machines</span>
				</div>
				{#if view.machines}
					<p class="primary num">{view.machines}</p>
					{#if view.machinesDetail}<p class="caption">{view.machinesDetail}</p>{/if}
				{:else}
					<p class="primary muted">Not available</p>
				{/if}
			</div>
		</div>
	{/if}
</section>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
		font-size: var(--gh-ui);
		line-height: var(--gh-lh-ui);
		color: var(--gh-text);
	}

	.resources {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.75rem;
	}

	.tile {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
		padding: 1rem;
		border: 1px solid var(--gh-line);
		border-radius: var(--gh-r-row);
		background: var(--gh-field);
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		color: var(--gh-muted);
	}

	.glyph {
		display: inline-grid;
		flex: none;
		color: var(--gh-muted);
	}

	.title {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--gh-text);
		font-weight: 600;
	}

	.level {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex: none;
		margin-left: auto;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
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

	.amount {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 0 0.25rem;
		margin: 0;
		font-family: var(--gh-mono);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.used {
		font-size: var(--gh-reading);
		line-height: var(--gh-lh-reading);
		font-weight: 600;
		color: var(--gh-text);
	}

	.of {
		color: var(--gh-muted-strong);
	}

	.pct {
		font-size: var(--gh-caption);
		color: var(--gh-muted);
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

	.caption {
		margin: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
		font-variant-numeric: tabular-nums;
	}

	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
		gap: 1.5rem;
	}

	.fact {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}

	.fact .head {
		margin-bottom: 0.25rem;
	}

	.primary {
		margin: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-variant-numeric: tabular-nums;
	}

	.muted {
		color: var(--gh-muted);
	}

	.num {
		font-variant-numeric: tabular-nums;
	}

	@media (max-width: 720px) {
		.resources {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
