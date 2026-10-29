<script lang="ts" module>
	export type StackAlertAction = { label: string; href?: string; onclick?: () => void };
	export type StackAlert = {
		id: string;
		tone: 'error' | 'warning' | 'info';
		title: string;
		hint?: string;
		actions?: StackAlertAction[];
		dismissible?: boolean;
	};
</script>

<script lang="ts">
	import { ChevronDown, CircleAlert, Info, TriangleAlert, X } from 'lucide-svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import { morphHeight } from '$lib/utils/motion.svelte';

	let {
		alerts,
		ondismiss = undefined
	}: {
		alerts: StackAlert[];
		ondismiss?: (id: string) => void;
	} = $props();

	const ICON = { error: CircleAlert, warning: TriangleAlert, info: Info };
	const RANK = { error: 0, warning: 1, info: 2 };

	let open = $state(false);

	const sorted = $derived([...alerts].sort((a, b) => RANK[a.tone] - RANK[b.tone]));
	const lead = $derived(sorted[0]);
	const shown = $derived(open ? sorted : sorted.slice(0, 1));
	const hidden = $derived(sorted.length - 1);

	$effect(() => {
		if (sorted.length < 2) open = false;
	});
</script>

{#if lead}
	<div class="wrap" class:wrap--stacked={!open && hidden > 0} data-tone={lead.tone}>
		<section class="stack" aria-label="Problems" {@attach morphHeight}>
			<div class="inner">
				{#each shown as alert, i (alert.id)}
					{@const Glyph = ICON[alert.tone]}
					<div class="row row--{alert.tone}" class:row--open={open}>
						<span class="icon"><Glyph size={16} aria-hidden="true" /></span>
						<p class="text">
							<span class="title">{alert.title}</span>
							{#if alert.hint}<span class="hint">{alert.hint}</span>{/if}
						</p>
						<span class="acts">
							{#each alert.actions ?? [] as act (act.label)}
								{#if act.href}
									<Button
										variant="secondary"
										size="sm"
										href={act.href}
										target="_blank"
										rel="noopener noreferrer">{act.label}</Button
									>
								{:else}
									<Button variant="secondary" size="sm" onclick={act.onclick}>{act.label}</Button>
								{/if}
							{/each}
							{#if alert.dismissible && ondismiss}
								<Button
									variant="ghost"
									size="sm"
									icon={X}
									label="Dismiss {alert.title}"
									onclick={() => ondismiss(alert.id)}
								/>
							{/if}
							{#if i === 0 && hidden > 0}
								<button
									type="button"
									class="more"
									aria-expanded={open}
									onclick={() => (open = !open)}
								>
									{open ? 'Less' : `+${hidden} more`}
									<span class="chev" class:chev--open={open}><ChevronDown size={14} /></span>
								</button>
							{/if}
						</span>
					</div>
				{/each}
			</div>
		</section>
	</div>
{/if}

<style>
	.wrap {
		--tone-bg: var(--status-error-bg);
		--tone-edge: color-mix(in oklab, var(--status-error) 22%, var(--border-default));
		--tone-fg: var(--status-error);
		position: relative;
		isolation: isolate;
	}
	.wrap[data-tone='warning'] {
		--tone-bg: var(--status-warning-bg);
		--tone-edge: color-mix(in oklab, var(--status-warning) 26%, var(--border-default));
		--tone-fg: var(--status-warning);
	}
	.wrap[data-tone='info'] {
		--tone-bg: var(--status-info-bg);
		--tone-edge: color-mix(in oklab, var(--status-info) 22%, var(--border-default));
		--tone-fg: var(--status-info);
	}
	.wrap--stacked {
		margin-bottom: 0.5rem;
	}
	.wrap--stacked::before,
	.wrap--stacked::after {
		content: '';
		position: absolute;
		z-index: -1;
		height: 1rem;
		border-radius: 0 0 calc(var(--radius-card) * var(--corner-scale))
			calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--tone-bg) 70%, var(--bg-surface));
		box-shadow: inset 0 0 0 1px var(--tone-edge);
	}
	.wrap--stacked::before {
		inset: auto 0.625rem -0.3125rem;
	}
	.wrap--stacked::after {
		z-index: -2;
		inset: auto 1.25rem -0.5625rem;
		opacity: 0.6;
	}
	.stack {
		overflow: clip;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--tone-bg) 100%, var(--bg-surface));
		box-shadow:
			inset 0 0 0 1px var(--tone-edge),
			0 1px 2px color-mix(in oklab, var(--neutral-10) 6%, transparent);
	}
	.inner {
		display: flex;
		flex-direction: column;
	}
	.row {
		--row-fg: var(--status-error);
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 2.75rem;
		padding: 0.375rem 0.375rem 0.375rem 0.875rem;
	}
	.row + .row {
		box-shadow: inset 0 1px 0 var(--tone-edge);
	}
	.row--warning {
		--row-fg: var(--status-warning);
	}
	.row--info {
		--row-fg: var(--status-info);
	}
	.icon {
		display: flex;
		flex-shrink: 0;
		color: var(--row-fg);
	}
	.text {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		flex: 1 1 auto;
		min-width: 0;
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
	}
	.title {
		flex-shrink: 0;
		font-weight: var(--weight-semibold);
		color: var(--text-default);
		white-space: nowrap;
	}
	.hint {
		overflow: hidden;
		color: var(--text-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row--open.row--warning {
		background: var(--status-warning-bg);
	}
	.row--open.row--info {
		background: var(--status-info-bg);
	}
	.row--open.row--error {
		background: var(--status-error-bg);
	}
	.row--open .text {
		flex-direction: column;
		gap: 0.125rem;
		padding-block: 0.25rem;
	}
	.row--open .hint {
		white-space: normal;
	}
	.acts {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
	}
	.more {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		height: 1.75rem;
		padding: 0 0.5rem 0 0.625rem;
		border: none;
		border-radius: calc(0.5rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--tone-fg) 10%, transparent);
		color: var(--tone-fg);
		font-size: var(--text-footnote);
		font-weight: var(--weight-medium);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		cursor: pointer;
	}
	.more:hover {
		background: color-mix(in oklab, var(--tone-fg) 16%, transparent);
	}
	.chev {
		display: flex;
		transition: transform var(--spring-snap-duration) var(--spring-snap);
	}
	.chev--open {
		transform: rotate(180deg);
	}
</style>
