<script lang="ts">
	import { Palette, Trash2, Loader2, Crown, FolderInput } from 'lucide-svelte';
	import type { Project } from './types';

	let {
		project,
		canEdit = false,
		canDelete = false,
		canTransferOwnership = false,
		canMoveToOrg = false,
		transferPending = false,
		deleting = false,
		onCustomize,
		onDelete,
		onTransferOwnership,
		onMoveToOrg
	}: {
		project: Project;
		canEdit?: boolean;
		canDelete?: boolean;
		canTransferOwnership?: boolean;
		canMoveToOrg?: boolean;
		transferPending?: boolean;
		deleting?: boolean;
		onCustomize?: () => void;
		onDelete?: () => void;
		onTransferOwnership?: () => void;
		onMoveToOrg?: () => void;
	} = $props();
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
			{#if canTransferOwnership}
				<button
					onclick={onTransferOwnership}
					disabled={transferPending}
					class="pj-icon-btn pj-icon-btn--danger"
					aria-label="Transfer ownership"
					title={transferPending ? 'Transfer already requested' : 'Transfer ownership'}
				>
					<Crown class="h-4 w-4" />
				</button>
			{/if}
			{#if canMoveToOrg}
				<button
					onclick={onMoveToOrg}
					class="pj-icon-btn"
					aria-label="Move to organization"
					title="Move to organization"
				>
					<FolderInput class="h-4 w-4" />
				</button>
			{/if}
			{#if canDelete}
				<button
					onclick={onDelete}
					disabled={deleting}
					class="pj-icon-btn pj-icon-btn--danger"
					aria-label="Delete project"
					title="Delete"
				>
					{#if deleting}<Loader2 class="h-4 w-4 animate-spin" />{:else}<Trash2
							class="h-4 w-4"
						/>{/if}
				</button>
			{/if}
		</div>
	</div>
</div>
