<script lang="ts">
	import { goto } from '$app/navigation';
	import { ArrowLeft, Database, Pencil, Trash2 } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
	import type { DatabaseDetail } from './types';

	let {
		database,
		orgSlug,
		deleting,
		onOpenDeleteModal,
		onRename,
		statusOverride
	}: {
		database: DatabaseDetail;
		orgSlug: string;
		deleting: boolean;
		onOpenDeleteModal: () => void;
		onRename?: () => void;
		statusOverride?: string;
	} = $props();

	const effectiveStatus = $derived(statusOverride || database.status);
	const engineLabel = $derived(database.pgMajor ? `PG ${database.pgMajor}` : 'PostgreSQL');
</script>

{#if database.project && database.project.workspace}
	<button
		onclick={() =>
			goto(
				`/${orgSlug}/workspaces/${database.project!.workspace!.slug}/projects/${database.project!.slug}`
			)}
		class="db-back"
	>
		<ArrowLeft class="h-4 w-4" />
		{database.project.name}
	</button>
{/if}

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
	<Button variant="danger" size="sm" onclick={onOpenDeleteModal} loading={deleting}>
		{#if !deleting}
			<Trash2 class="h-4 w-4" />
		{/if}
		Delete
	</Button></div>

<style>
	.dbh-hero {
		display: flex;
		align-items: flex-start;
		gap: 1rem;
		padding: 1.375rem 1.5rem;
		border: 1px solid var(--border-default);
		border-radius: 1rem;
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
		border-radius: 0.875rem;
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
		font-size: 1.5rem;
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
		gap: 0.375rem;
		margin-top: 0.5rem;
	}
	.dbh-chip {
		display: inline-flex;
		align-items: center;
		font-size: 0.6875rem;
		font-weight: 550;
		color: var(--text-muted);
		background-color: var(--bg-sunken);
		border: 1px solid color-mix(in srgb, var(--border-default) 70%, transparent);
		border-radius: 9999px;
		padding: 0.2rem 0.55rem;
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
