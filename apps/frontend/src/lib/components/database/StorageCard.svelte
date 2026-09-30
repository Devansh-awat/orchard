<script lang="ts">
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { Alert, Button, Field, Input } from '$lib/components/ui';
	import type { DatabaseDetail } from './types';
	import { storageExpansionError, totalAllocatedStorage } from './storage-size';

	let {
		database,
		value = $bindable(''),
		dirty = $bindable(false),
		saving,
		warning,
		onExpand
	}: {
		database: DatabaseDetail;
		value: string;
		dirty: boolean;
		saving: boolean;
		warning: string | null;
		onExpand: () => void;
	} = $props();

	let confirmOpen = $state(false);
	const current = $derived(database.storageSize ?? 'Unknown');
	const instances = $derived(Math.max(1, database.replicas ?? 1));
	const validationError = $derived(
		dirty ? storageExpansionError(database.storageSize, value) : null
	);
	const total = $derived(totalAllocatedStorage(value, instances));
	const canExpand = $derived(dirty && validationError == null && !saving);
	const volume = $derived(database.liveStatus?.volume ?? null);
	const walPending = $derived(database.liveStatus?.walPendingSegments ?? 0);
	const fillTone = $derived(
		volume == null ? 'ok' : volume.percent >= 85 ? 'critical' : volume.percent >= 70 ? 'warn' : 'ok'
	);
</script>

<section class="sc-card">
	<div class="sc-header">
		<div>
			<h3 class="sc-title">Storage</h3>
			<p class="sc-live">{current} configured per instance</p>
		</div>
		<div class="sc-badge">{current}</div>
	</div>

	<div class="sc-body">
		<div class="sc-stats">
			<div>
				<span class="sc-value">{database.liveStatus?.size ?? 'Unavailable'}</span>
				<span class="sc-label">PostgreSQL data size</span>
			</div>
			<div>
				<span class="sc-value"
					>{volume ? `${volume.used} of ${volume.capacity}` : 'Unavailable'}</span
				>
				<span class="sc-label">volume used, including WAL</span>
			</div>
		</div>

		{#if volume}
			<div class="sc-fill" data-tone={fillTone}>
				<div class="sc-fill-track">
					<div class="sc-fill-bar" style:width={`${Math.min(100, volume.percent)}%`}></div>
				</div>
				<span class="sc-fill-label">
					{volume.percent}% full
					{#if walPending > 0}
						<span class="sc-fill-sep">·</span>
						{walPending} WAL {walPending === 1 ? 'segment' : 'segments'} waiting to archive
					{/if}
				</span>
			</div>
		{/if}

		<Field
			label="New capacity"
			for="database-storage-size"
			error={validationError}
			hint="Whole-number Mi, Gi, or Ti. Maximum 200Gi."
		>
			<Input
				id="database-storage-size"
				{value}
				placeholder="10Gi"
				disabled={saving}
				error={validationError != null}
				oninput={(event: Event) => {
					value = (event.currentTarget as HTMLInputElement).value;
					dirty = value.trim() !== database.storageSize;
				}}
			/>
		</Field>

		<p class="sc-desc">
			Volumes grow online without restarting PostgreSQL. Storage cannot be reduced later.
			{#if total && validationError == null}
				This will allocate {total} across {instances} {instances === 1 ? 'instance' : 'instances'}.
			{/if}
		</p>

		{#if database.liveStatus?.archiving?.ok === false}
			<Alert tone="warning" title="WAL archiving is failing">
				Expanding creates headroom, but WAL will continue filling the volume until archiving is
				fixed.
			</Alert>
		{/if}

		{#if warning}
			<Alert tone="warning" title="Storage expanded">{warning}</Alert>
		{/if}

		<div class="sc-actions">
			<Button
				variant="ghost"
				size="sm"
				disabled={!dirty || saving}
				onclick={() => {
					value = database.storageSize ?? '';
					dirty = false;
				}}>Reset</Button
			>
			<Button
				variant="primary"
				size="sm"
				disabled={!canExpand}
				loading={saving}
				onclick={() => (confirmOpen = true)}
			>
				{saving ? 'Expanding...' : 'Expand storage'}
			</Button>
		</div>
	</div>
</section>

<ConfirmModal
	bind:open={confirmOpen}
	title="Expand database storage?"
	description={`This permanently grows every instance volume from ${current} to ${value}. The operation cannot be reversed.`}
	confirmLabel="Expand storage"
	danger={false}
	onconfirm={onExpand}
	oncancel={() => {}}
/>

<style>
	.sc-card {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-xl);
		background-color: var(--bg-raised);
		box-shadow: var(--elev-1);
		overflow: hidden;
		margin-bottom: 1rem;
	}
	.sc-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.25rem 1.5rem;
	}
	.sc-title {
		font-size: var(--text-body);
		font-weight: 600;
		color: var(--text-default);
		margin: 0;
		line-height: 1.3;
	}
	.sc-live {
		font-size: var(--text-caption);
		color: var(--text-muted);
		margin: 0.25rem 0 0;
	}
	.sc-badge {
		display: inline-flex;
		padding: 0.25rem 0.75rem;
		border-radius: var(--radius-2xl);
		font-size: var(--text-micro);
		font-weight: 600;
		background-color: var(--accent-subtle);
		color: var(--accent);
		font-family: var(--font-mono);
	}
	.sc-body {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 0 1.5rem 1.5rem;
	}
	.sc-stats {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
	}
	.sc-stats > div {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.sc-value {
		font-family: var(--font-mono);
		font-size: var(--text-body);
		font-weight: 600;
		color: var(--text-default);
	}
	.sc-label {
		font-size: var(--text-micro);
		color: var(--text-muted);
	}
	.sc-desc {
		font-size: var(--text-caption);
		color: var(--text-muted);
		margin: 0;
	}
	.sc-fill {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		color: var(--text-muted);
	}
	.sc-fill[data-tone='warn'] {
		color: var(--status-warning);
	}
	.sc-fill[data-tone='critical'] {
		color: var(--status-error);
	}
	.sc-fill-track {
		height: 0.375rem;
		border-radius: var(--radius-pill);
		background-color: color-mix(in srgb, currentColor 12%, transparent);
		overflow: hidden;
	}
	.sc-fill-bar {
		height: 100%;
		border-radius: inherit;
		background-color: var(--accent);
		transition: width var(--dur-base);
	}
	.sc-fill[data-tone='warn'] .sc-fill-bar,
	.sc-fill[data-tone='critical'] .sc-fill-bar {
		background-color: currentColor;
	}
	.sc-fill-label {
		font-size: var(--text-micro);
		font-family: var(--font-mono);
	}
	.sc-fill-sep {
		margin: 0 0.375rem;
		opacity: 0.6;
	}
	.sc-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding-top: 1rem;
		border-top: 1px solid color-mix(in srgb, var(--border-default) 40%, transparent);
	}
</style>
