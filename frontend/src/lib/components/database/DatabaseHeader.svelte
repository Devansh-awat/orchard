<script lang="ts">
	import { goto } from '$app/navigation';
	import { ArrowLeft, Loader2, Database, Trash2 } from 'lucide-svelte';
	import type { DatabaseDetail } from './types';

	let {
		database,
		orgSlug,
		deleting,
		onOpenDeleteModal,
		statusOverride
	}: {
		database: DatabaseDetail;
		orgSlug: string;
		deleting: boolean;
		onOpenDeleteModal: () => void;
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
			<span class="db-status db-status-{effectiveStatus}">{effectiveStatus}</span>
		</div>
	</div>
	<button onclick={onOpenDeleteModal} disabled={deleting} class="db-btn db-btn-danger">
		{#if deleting}
			<Loader2 class="h-4 w-4 animate-spin" />
		{:else}
			<Trash2 class="h-4 w-4" />
		{/if}
		Delete
	</button>
</div>
