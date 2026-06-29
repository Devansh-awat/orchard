<script lang="ts">
	import { Sparkles, Plus, RefreshCw } from 'lucide-svelte';

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
	<div class="empty">
		<div class="empty-icon"><Sparkles size={28} /></div>
		<h3 class="empty-h">
			{loadError.status === 403 ? "Can't load this organization" : 'Failed to load overview'}
		</h3>
		<p class="empty-p">
			{loadError.status === 403
				? "The server says you don't have access right now. This usually clears on reload."
				: loadError.message}
		</p>
		<button class="btn-primary" style="margin-top:0.5rem" onclick={() => location.reload()}>
			<RefreshCw size={15} /> Reload
		</button>
	</div>
{:else}
	<div class="empty">
		<div class="empty-icon"><Sparkles size={28} /></div>
		<h3 class="empty-h">
			{canCreateProjects ? 'Deploy your first app' : 'No projects to show yet'}
		</h3>
		<p class="empty-p">
			{canCreateProjects
				? 'Import a GitHub repo or deploy a Docker image.'
				: 'A project admin needs to invite you to a specific project before anything shows up here.'}
		</p>
		{#if canCreateProjects}
			<a href="/{orgSlug}/new" class="btn-primary" style="margin-top:0.5rem"
				><Plus size={15} /> New App</a
			>
		{/if}
	</div>
{/if}
