<script lang="ts">
	import { Crown, FolderInput, Trash2 } from 'lucide-svelte';
	import { Button, SectionCard } from '$lib/components/ui';

	let {
		canDelete = false,
		canTransferOwnership = false,
		canMoveToOrg = false,
		transferPending = false,
		deleting = false,
		onDelete,
		onTransferOwnership,
		onMoveToOrg
	}: {
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
				<span class="ps-name">Delete project</span>
				<Button variant="danger" size="sm" loading={deleting} onclick={onDelete}>
					<Trash2 class="h-3.5 w-3.5" />
					Delete
				</Button>
			</div>
		{/if}
	</div>
</SectionCard>

<style>
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
