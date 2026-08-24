<script lang="ts">
	import { Button, Slider } from '$lib/components/ui';
	import type { DatabaseDetail } from './types';

	let {
		database,
		replicas = $bindable(1),
		replicasDirty = $bindable(false),
		saving,
		onScale
	}: {
		database: DatabaseDetail | null;
		replicas: number;
		replicasDirty: boolean;
		saving: boolean;
		onScale: () => void;
	} = $props();

	const max = $derived(Math.max(1, database?.maxReplicas ?? 5));
	const current = $derived(Math.max(1, database?.replicas ?? 1));
	const ready = $derived(database?.liveStatus?.readyReplicas);
	const running = $derived(database?.liveStatus?.replicas);

	const description = $derived(
		replicas === 1
			? 'One instance. Reads and writes both go to it, and it has nothing to fail over to.'
			: `One primary and ${replicas - 1} read ${replicas === 2 ? 'replica' : 'replicas'}. Replicas stream from the primary and serve reads on the read endpoints, a few milliseconds behind. They double as failover targets: if the primary goes away one is promoted automatically.`
	);
</script>

<section class="rc-card">
	<div class="rc-header">
		<div>
			<h3 class="rc-title">Instances</h3>
			{#if ready != null && running != null}
				<p class="rc-live">{ready} of {running} ready</p>
			{/if}
		</div>
		<div class="rc-badge">{current}x</div>
	</div>

	<div class="rc-body">
		<div class="rc-slider">
			<Slider
				bind:value={replicas}
				min={1}
				{max}
				label="PostgreSQL instances"
				ticks
				disabled={saving}
				onchange={(next) => {
					replicasDirty = next !== current;
				}}
			/>
			<span class="rc-value">{replicas}</span>
		</div>

		<p class="rc-desc">{description}</p>

		{#if replicas > current}
			<p class="rc-warn">
				Adding {replicas - current}
				{replicas - current === 1 ? 'instance' : 'instances'} multiplies this cluster's CPU and memory
				against your quota. Each new replica clones the primary before it reports ready.
			</p>
		{:else if replicas < current}
			<p class="rc-warn">
				Removing {current - replicas}
				{current - replicas === 1 ? 'instance' : 'instances'}. The highest numbered replicas are
				retired and their volumes deleted.
			</p>
		{/if}

		<div class="rc-actions">
			<Button
				variant="ghost"
				size="sm"
				disabled={!replicasDirty || saving}
				onclick={() => {
					replicas = current;
					replicasDirty = false;
				}}>Reset</Button
			>
			<Button
				variant="primary"
				size="sm"
				disabled={!replicasDirty}
				loading={saving}
				onclick={onScale}
			>
				{saving ? 'Scaling...' : `Scale to ${replicas}`}
			</Button>
		</div>
	</div>
</section>

<style>
	.rc-card {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xl);
		background-color: var(--bg-raised);
		box-shadow: var(--elev-1);
		overflow: hidden;
		margin-bottom: 1rem;
	}
	.rc-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.25rem 1.5rem;
	}
	.rc-title {
		font-size: var(--text-body);
		font-weight: 600;
		color: var(--text-default);
		margin: 0;
		line-height: 1.3;
	}
	.rc-live {
		font-size: var(--text-caption);
		color: var(--text-muted);
		margin: 0.25rem 0 0;
	}
	.rc-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.25rem 0.75rem;
		border-radius: var(--radius-2xl);
		font-size: var(--text-micro);
		font-weight: 600;
		flex-shrink: 0;
		background-color: var(--accent-subtle);
		color: var(--accent);
		font-family: var(--font-mono);
	}
	.rc-body {
		padding: 0 1.5rem 1.5rem;
	}
	.rc-slider {
		display: flex;
		align-items: center;
		gap: 0.875rem;
	}
	.rc-value {
		font-family: var(--font-mono);
		font-size: var(--text-headline);
		font-weight: 600;
		color: var(--text-default);
		min-width: 1.25rem;
		text-align: right;
	}
	.rc-desc {
		font-size: var(--text-caption);
		color: var(--text-muted);
		margin: 0.5rem 0 0;
	}
	.rc-warn {
		font-size: var(--text-caption);
		color: var(--text-default);
		background-color: var(--accent-subtle);
		border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
		border-radius: var(--radius-md);
		padding: 0.625rem 0.75rem;
		margin: 0.75rem 0 0;
	}
	.rc-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid color-mix(in srgb, var(--border-default) 40%, transparent);
	}
</style>
