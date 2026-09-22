<script lang="ts">
	import { Palette } from 'lucide-svelte';
	import type { Project } from './types';

	let {
		project,
		canEdit = false,
		onCustomize
	}: {
		project: Project;
		canEdit?: boolean;
		onCustomize?: () => void;
	} = $props();

	const appCount = $derived(project.deployments?.length ?? 0);
	const memberCount = $derived(project.members?.length ?? 0);
</script>

<div class="pj-header">
	<div class="pj-header-top">
		<div class="pj-header-info">
			<h1 class="pj-title">
				{#if project.icon}
					<span class="pj-title-icon">
						{#if /^https?:\/\//.test(project.icon)}
							<img src={project.icon} alt="" />
						{:else}
							{project.icon}
						{/if}
					</span>
				{/if}
				{#if project.owner?.username}<span class="pj-title-owner">{project.owner.username}@</span
					>{/if}{project.name}
			</h1>
			{#if project.description}
				<p class="pj-description">{project.description}</p>
			{/if}
			<p class="pj-meta">
				<span>{appCount} app{appCount === 1 ? '' : 's'}</span>
				{#if memberCount > 0}
					<span class="pj-meta-dot" aria-hidden="true"></span>
					<span>{memberCount} member{memberCount === 1 ? '' : 's'}</span>
				{/if}
				{#if project.organization?.name}
					<span class="pj-meta-dot" aria-hidden="true"></span>
					<span>{project.organization.name}</span>
				{/if}
			</p>
		</div>
		<div class="pj-header-actions">
			{#if canEdit}
				<button
					onclick={onCustomize}
					class="pj-icon-btn"
					aria-label="Customize project"
					title="Customize"
				>
					<Palette class="h-4 w-4" />
				</button>
			{/if}
		</div>
	</div>
</div>
