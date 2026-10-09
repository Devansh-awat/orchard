<script lang="ts">
	import { CircleAlert } from 'lucide-svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import { clock } from '$lib/utils/clock.svelte';
	import { USAGE_POLL_MS, fetchMachineUsage, usageView, type MachineUsage } from './machine-usage';
	import type { Sandbox } from '$lib/types/sandbox';

	let { machine, open, owner }: { machine: Sandbox; open: boolean; owner: boolean } = $props();

	let usage = $state<MachineUsage | null>(null);
	let failed = $state(false);
	let skew = $state(0);
	let shownFor: string | null = null;

	const view = $derived(usage ? usageView(usage, clock.now + skew, owner) : null);
	const empty = $derived(
		!!view && view.meters.length === 0 && view.lines.length === 0 && !view.footer
	);

	$effect(() => {
		const id = machine.id;
		void machine.status;
		if (!open) return;
		if (shownFor !== id) {
			shownFor = id;
			usage = null;
			failed = false;
		}
		let cancelled = false;
		const load = async () => {
			const next = await fetchMachineUsage(id);
			if (cancelled) return;
			if (next) {
				usage = next;
				failed = false;
				const server = Date.parse(next.fetchedAt);
				skew = Number.isFinite(server) ? server - Date.now() : 0;
			} else {
				failed = true;
			}
		};
		void load();
		const timer = setInterval(load, USAGE_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	});
</script>

{#if !empty && !(failed && !usage)}
	<div class="usage" role="group" aria-label="Machine usage">
		{#if !view}
			{#each [0, 1, 2] as i (i)}
				<div class="meter" aria-hidden="true">
					<div class="top"><Skeleton width={i === 0 ? '40%' : '55%'} height="0.5rem" /></div>
					<Skeleton height="0.25rem" rounded="0.125rem" />
				</div>
			{/each}
		{:else}
			{#if view.meters.length}
				<div class="group">
					{#each view.meters as m (m.key)}
						<div class="meter">
							<div class="top">
								<span class="label">{m.label}</span>
								{#if m.near}
									<span class="near">
										<span class="near-glyph"><CircleAlert size={12} strokeWidth={1.75} /></span>
										Near limit
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
								aria-valuenow={Math.round(m.fraction * 100)}
								aria-valuetext={m.value}
							>
								<div class="fill" style:width="{Math.max(m.fraction * 100, 1.5)}%"></div>
							</div>
						</div>
					{/each}
				</div>
			{/if}
			{#if view.lines.length}
				<div class="lines">
					{#each view.lines as line (line)}
						<p class="line">{line}</p>
					{/each}
				</div>
			{/if}
			{#if view.footer}
				<p class="foot">{view.footer}</p>
			{/if}
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
		padding: 0.25rem 0.5rem 0.5rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}

	.group {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.lines {
		display: flex;
		flex-direction: column;
	}

	.meter {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.top {
		display: flex;
		align-items: center;
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

	.near {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex: none;
		color: var(--gh-text);
		font-weight: 600;
		white-space: nowrap;
	}

	.near-glyph {
		display: inline-grid;
		color: var(--status-warning);
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

	.line,
	.foot {
		margin: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-variant-numeric: tabular-nums;
	}

	.foot {
		color: var(--gh-faint);
	}
</style>
