<script lang="ts">
	import { Sparkles, Plus, RefreshCw } from 'lucide-svelte';
	import { EmptyState as UiEmptyState, Button } from '$lib/components/ui';

	let {
		variant,
		canCreateProjects,
		orgSlug,
		loadError
	}: {
		variant: 'error' | 'empty';
		canCreateProjects: boolean;
		orgSlug: string;
		loadError?: { status: number; message: string } | null;
	} = $props();
</script>

{#if variant === 'error' && loadError}
	<UiEmptyState
		title={loadError.status === 403 ? "Can't load this organization" : 'Failed to load overview'}
		description={loadError.status === 403
			? "The server says you don't have access right now. This usually clears on reload."
			: loadError.message}
	>
		{#snippet icon()}<Sparkles size={28} />{/snippet}
		<Button variant="primary" onclick={() => location.reload()}>
			<RefreshCw size={15} /> Reload
		</Button>
	</UiEmptyState>
{:else if canCreateProjects}
	<UiEmptyState
		title="Deploy your first app"
		description="Import a GitHub repo or deploy a Docker image."
	>
		{#snippet icon()}<Sparkles size={28} />{/snippet}
		<Button variant="primary" href="/{orgSlug}/new"><Plus size={15} /> New app</Button>
	</UiEmptyState>
{:else}
	<UiEmptyState
		title="No projects to show yet"
		description="A project admin needs to invite you to a specific project before anything shows up here."
	>
		{#snippet icon()}<Sparkles size={28} />{/snippet}
	</UiEmptyState>
{/if}
