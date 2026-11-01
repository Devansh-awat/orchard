<script lang="ts">
	import { Flame, RotateCcw, ShieldAlert, TriangleAlert, Activity, Database } from 'lucide-svelte';
	import { anomalyAge, type Anomaly, type AnomalyScope } from './anomalies';
	import { anomalyFeed } from './anomaly-feed.svelte';

	let {
		scope,
		hideResource = false,
		extra = [],
		kinds = null
	}: {
		scope: AnomalyScope;
		hideResource?: boolean;
		extra?: Anomaly[];
		kinds?: readonly string[] | null;
	} = $props();

	const feed = anomalyFeed(
		() => scope,
		() => kinds
	);
	const items = $derived(feed.items);
	const loaded = $derived(feed.loaded);

	const icons: Record<string, typeof Flame> = {
		oom: Flame,
		db_oom: Flame,
		crashloop: RotateCcw,
		db_crashing: RotateCcw,
		rollback: RotateCcw,
		apply_failed: ShieldAlert,
		build_failed: ShieldAlert,
		alert: Activity,
		error_spike: TriangleAlert,
		under_replicated: TriangleAlert
	};
	const shown = $derived([
		...items,
		...extra.filter((e) => !items.some((a) => a.resource.id === e.resource.id))
	]);
	const worst = $derived(
		shown.some((a) => a.severity === 'critical' || a.severity === 'error')
			? 'error'
			: (shown[0]?.severity ?? 'warning')
	);
</script>

{#if loaded && shown.length > 0}
	<section class="anom anom--{worst}" aria-label="Alerts">
		<ul class="anom-list">
			{#each shown as a (a.id)}
				{@const Icon = icons[a.kind] ?? (a.resource.kind === 'database' ? Database : TriangleAlert)}
				<li class="anom-row anom-row--{a.severity}">
					<span class="anom-icon"><Icon size={15} /></span>
					<div class="anom-body">
						<p class="anom-title">
							{#if !hideResource}
								<a class="anom-resource" href={a.href}>{a.resource.name}</a>
								<span class="anom-title-rest">{a.kind === 'alert' ? `· ${a.title}` : a.title}</span>
							{:else}
								{a.title.replace(/^[a-z]/, (c) => c.toUpperCase())}
							{/if}
						</p>
						<p class="anom-detail">
							{a.detail}{#if anomalyAge(a.since)}<span class="anom-age">
									· {anomalyAge(a.since)}</span
								>{/if}
						</p>
					</div>
					{#if a.action}
						<a class="anom-action" href={a.action.href}>{a.action.label}</a>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.anom {
		--anom-tone: var(--status-warning);
		border-radius: var(--radius-xl);
		border: 1px solid color-mix(in srgb, var(--anom-tone) 28%, var(--surface-border));
		background: color-mix(in srgb, var(--anom-tone) 6%, var(--surface-bg));
		margin-bottom: var(--space-5);
		overflow: hidden;
	}
	.anom--error,
	.anom--critical {
		--anom-tone: var(--status-error);
	}
	.anom-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.anom-row {
		--row-tone: var(--status-warning);
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
	}
	.anom-row--error,
	.anom-row--critical {
		--row-tone: var(--status-error);
	}
	.anom-row + .anom-row {
		border-top: 1px solid color-mix(in srgb, var(--anom-tone) 14%, var(--surface-border));
	}
	.anom-icon {
		display: grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius-md);
		flex-shrink: 0;
		color: var(--row-tone);
		background: color-mix(in srgb, var(--row-tone) 12%, transparent);
	}
	.anom-body {
		flex: 1;
		min-width: 0;
	}
	.anom-title {
		margin: 0;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
	}
	.anom-resource {
		color: var(--row-tone);
		text-decoration: none;
	}
	.anom-resource:hover {
		text-decoration: underline;
	}
	.anom-title-rest {
		margin-left: 0.25rem;
	}
	.anom-detail {
		margin: 0.125rem 0 0;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.anom-age {
		color: var(--surface-muted);
	}
	.anom-action {
		flex-shrink: 0;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		padding: 0.375rem 0.625rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--row-tone) 30%, var(--surface-border));
		color: var(--row-tone);
		text-decoration: none;
		background: transparent;
		transition: background-color var(--dur-fast) ease;
	}
	.anom-action:hover {
		background: color-mix(in srgb, var(--row-tone) 10%, transparent);
	}
</style>
