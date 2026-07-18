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

<div class="db-header">
	<div class="db-header-info">
		<div class="db-header-title-row">
			<div class="db-icon-badge">
				<Database size={16} />
			</div>
			<h1 class="db-title">{database.name}</h1>
			{#if onRename}
				<button
					class="db-rename-btn"
					title="Rename"
					aria-label="Rename database"
					onclick={onRename}
				>
					<Pencil size={14} />
				</button>
			{/if}
			<span class="db-status db-status-{effectiveStatus}">{effectiveStatus}</span>
		</div>
	</div>
	<Button variant="danger" size="sm" onclick={onOpenDeleteModal} loading={deleting}>
		{#if !deleting}
			<Trash2 class="h-4 w-4" />
		{/if}
		Delete
	</Button>
</div>
