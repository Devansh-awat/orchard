<script lang="ts">
	import { AlertTriangle, Trash2 } from 'lucide-svelte';
	import { Modal, Button } from '$lib/components/ui';

	let {
		databaseName,
		deleteCountdownActive,
		deleteCountdown,
		deleteProgress,
		onStartDeleteCountdown,
		onCancelDelete
	}: {
		databaseName: string;
		deleteCountdownActive: boolean;
		deleteCountdown: number;
		deleteProgress: number;
		onStartDeleteCountdown: () => void;
		onCancelDelete: () => void;
	} = $props();

	let open = $state(true);
</script>

<Modal bind:open size="sm" title={`Delete "${databaseName}"?`} onclose={onCancelDelete}>
	<div class="modal-icon-danger">
		<AlertTriangle size={20} />
	</div>
	<p class="modal-desc">
		This permanently <strong>drops the PostgreSQL database</strong> and its user. All data will be lost.
		This cannot be undone.
	</p>

	{#if deleteCountdownActive}
		<div class="modal-progress-wrapper">
			<div class="modal-progress-track">
				<div class="modal-progress-fill" style="width: {deleteProgress}%"></div>
			</div>
			<span class="modal-countdown">
				{#if deleteCountdown > 0}
					Deleting in {deleteCountdown}s
				{:else}
					Deleting now
				{/if}
			</span>
		</div>
	{/if}

	{#snippet footer()}
		{#if deleteCountdownActive}
			<Button variant="secondary" onclick={onCancelDelete}>Abort</Button>
		{:else}
			<Button variant="secondary" onclick={onCancelDelete}>Cancel</Button>
			<Button variant="danger" onclick={onStartDeleteCountdown}>
				<Trash2 class="h-4 w-4" />
				Delete
			</Button>
		{/if}
	{/snippet}
</Modal>
