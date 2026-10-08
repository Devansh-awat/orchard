<script lang="ts">
	import { Crown, FolderInput, Trash2 } from 'lucide-svelte';
	import { Button, SectionCard } from '$lib/components/ui';
	import RegistryCredentials from './RegistryCredentials.svelte';

	let {
		projectId,
		canEdit = false,
		canDelete = false,
		canTransferOwnership = false,
		canMoveToOrg = false,
		transferPending = false,
		deleting = false,
		onDelete,
		onTransferOwnership,
		onMoveToOrg
	}: {
		projectId: string;
		canEdit?: boolean;
		canDelete?: boolean;
		canTransferOwnership?: boolean;
		canMoveToOrg?: boolean;
		transferPending?: boolean;
		deleting?: boolean;
		onDelete?: () => void;
		onTransferOwnership?: () => void;
		onMoveToOrg?: () => void;
	} = $props();
</script>

<div class="ps-stack">
	<RegistryCredentials {projectId} {canEdit} />

	<SectionCard title="Danger zone">
		<div class="ps-rows">
			{#if canTransferOwnership}
				<div class="ps-row">
					<span class="ps-name">Transfer ownership</span>
					<Button
						variant="secondary"
						size="sm"
						disabled={transferPending}
						onclick={onTransferOwnership}
					>
						<Crown class="h-3.5 w-3.5" />
						{transferPending ? 'Transfer pending' : 'Transfer'}
					</Button>
				</div>
			{/if}

			{#if canMoveToOrg}
				<div class="ps-row">
					<span class="ps-name">Move to another organization</span>
					<Button variant="secondary" size="sm" onclick={onMoveToOrg}>
						<FolderInput class="h-3.5 w-3.5" />
						Move
					</Button>
				</div>
			{/if}

			{#if canDelete}
				<div class="ps-row">
					<span class="ps-text">
						<span class="ps-name">Delete project</span>
						<span class="ps-hint">
							Permanently removes every environment, app, database, backup, domain and job in it.
							You will be asked to type the project name.
						</span>
					</span>
					<Button variant="danger" size="sm" loading={deleting} onclick={onDelete}>
						<Trash2 class="h-3.5 w-3.5" />
						Delete
					</Button>
				</div>
			{/if}
		</div>
	</SectionCard>
</div>

<style>
	.ps-stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.ps-rows {
		display: flex;
		flex-direction: column;
	}

	.ps-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-5);
		padding: var(--space-3) 0;
	}

	.ps-row + .ps-row {
		box-shadow: inset 0 1px 0 var(--rule);
	}

	.ps-text {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}

	.ps-hint {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.ps-name {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		letter-spacing: var(--track-headline);
		color: var(--text-default);
	}

	@media (max-width: 640px) {
		.ps-row {
			flex-direction: column;
			align-items: flex-start;
			gap: var(--space-2);
		}
	}
</style>
