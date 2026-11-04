<script lang="ts">
	import { AlertTriangle, Trash2 } from 'lucide-svelte';
	import { Modal, Button } from '$lib/components/ui';

	let {
		databaseName,
		recoverable = true,
		deleteCountdownActive,
		deleteCountdown,
		deleteProgress,
		onStartDeleteCountdown,
		onCancelDelete
	}: {
		databaseName: string;
		recoverable?: boolean;
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
		{#if recoverable}
			Apps using it lose their connection now. You can bring it back from <strong
				>Recently deleted</strong
			> on the project for 30 days. After that, Orchard removes it and its backups.
		{:else}
			Apps using it lose their connection now. It has no backups, so <strong
				>you can't bring it back</strong
			>.
		{/if}
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
