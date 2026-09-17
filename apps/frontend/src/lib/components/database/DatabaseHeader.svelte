<script lang="ts">
	import { Database, Pencil, Trash2, Play, RefreshCw, Square } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
	import type { DatabaseDetail } from './types';

	let {
		database,
		deleting,
		stopped = false,
		stopping = false,
		starting = false,
		restarting = false,
		onOpenDeleteModal,
		onRename,
		onStop,
		onStart,
		onRestart,
		statusOverride
	}: {
		database: DatabaseDetail;
		deleting: boolean;
		stopped?: boolean;
		stopping?: boolean;
		starting?: boolean;
		restarting?: boolean;
		onOpenDeleteModal: () => void;
		onRename?: () => void;
		onStop?: () => void;
		onStart?: () => void;
		onRestart?: () => void;
		statusOverride?: string;
	} = $props();

	const effectiveStatus = $derived(statusOverride || database.status);
	const engineLabel = $derived(database.pgMajor ? `PG ${database.pgMajor}` : 'PostgreSQL');
</script>

<div class="dbh-hero">
	<div class="dbh-hero-icon">
		<Database size={22} />
	</div>
	<div class="dbh-hero-id">
		<div class="dbh-hero-titlerow">
			<h1 class="dbh-hero-name">{database.name}</h1>
			{#if onRename}
				<button
					class="db-rename-btn"
					title="Rename"
					aria-label="Rename database"
					onclick={onRename}
				>
					<Pencil size={13} />
				</button>
			{/if}
			<span class="db-status db-status-{effectiveStatus}">{effectiveStatus}</span>
		</div>
		<div class="dbh-hero-chips">
			<span class="dbh-chip dbh-chip--mono">{engineLabel}</span>
			{#if database.storageSize}
				<span class="dbh-chip dbh-chip--mono">{database.storageSize}</span>
			{/if}
			{#if database.namespace}
				<span class="dbh-chip dbh-chip--mono dbh-chip--faint">{database.namespace}</span>
			{/if}
		</div>
	</div>
	<div class="dbh-actions">
		{#if database.mode === 'cnpg'}
			{#if stopped}
				{#if onStart}
					<Button variant="primary" size="sm" onclick={onStart} loading={starting}>
						{#if !starting}<Play class="h-3.5 w-3.5" />{/if}
						Start
					</Button>
				{/if}
			{:else}
				{#if onRestart}
					<Button variant="secondary" size="sm" onclick={onRestart} loading={restarting}>
						{#if !restarting}<RefreshCw class="h-3.5 w-3.5" />{/if}
						Restart
					</Button>
				{/if}
				{#if onStop}
					<Button variant="secondary" size="sm" onclick={onStop} loading={stopping}>
						{#if !stopping}<Square class="h-3.5 w-3.5" />{/if}
						Stop
					</Button>
				{/if}
			{/if}
		{/if}
		<Button variant="danger" size="sm" onclick={onOpenDeleteModal} loading={deleting}>
			{#if !deleting}
				<Trash2 class="h-4 w-4" />
			{/if}
			Delete
		</Button>
	</div>
</div>

<style>
	.dbh-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}
	.dbh-hero {
		display: flex;
		align-items: flex-start;
		gap: 1rem;
		padding: 1.375rem 1.5rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background-color: var(--bg-surface);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
		margin-bottom: 1.25rem;
	}
	.dbh-hero-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 3rem;
		height: 3rem;
		border-radius: var(--radius-lg);
		flex-shrink: 0;
		background: linear-gradient(
			135deg,
			color-mix(in srgb, var(--accent) 16%, transparent),
			color-mix(in srgb, var(--accent) 6%, transparent)
		);
		color: var(--accent);
	}
	.dbh-hero-id {
		flex: 1;
		min-width: 0;
	}
	.dbh-hero-titlerow {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.dbh-hero-name {
		font-size: var(--text-title-2);
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1.2;
		color: var(--text-default);
		margin: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.dbh-hero-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.dbh-chip {
		display: inline-flex;
		align-items: center;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		color: var(--text-muted);
		background-color: var(--bg-sunken);
		border: 1px solid color-mix(in srgb, var(--border-default) 70%, transparent);
		border-radius: var(--radius-pill);
		padding: 0.25rem 0.5rem;
	}
	.dbh-chip--mono {
		font-family: var(--font-mono, monospace);
	}
	.dbh-chip--faint {
		color: var(--text-faint);
	}
	@media (max-width: 640px) {
		.dbh-hero {
			flex-wrap: wrap;
		}
	}
</style>
