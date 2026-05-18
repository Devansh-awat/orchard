<script lang="ts">
	import { AlertTriangle, X, Trash2 } from 'lucide-svelte';
	import { fade, scale } from 'svelte/transition';

	let {
		databaseName,
		deleteCountdownActive,
		deleteCountdown,
		deleteProgress,
		onStartDeleteCountdown,
		onCancelDelete,
	}: {
		databaseName: string;
		deleteCountdownActive: boolean;
		deleteCountdown: number;
		deleteProgress: number;
		onStartDeleteCountdown: () => void;
		onCancelDelete: () => void;
	} = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal-overlay" transition:fade={{ duration: 150 }} onclick={onCancelDelete}>
	<div
		class="modal-card"
		transition:scale={{ duration: 200, start: 0.95 }}
		onclick={(e) => e.stopPropagation()}
	>
		<div class="modal-header">
			<div class="modal-icon-danger">
				<AlertTriangle size={20} />
			</div>
			<button class="modal-close" onclick={onCancelDelete}>
				<X size={16} />
			</button>
		</div>

		<h2 class="modal-title">Delete "{databaseName}"?</h2>
		<p class="modal-desc">
			This will permanently <strong>drop the PostgreSQL database</strong> and its user.
			All data will be lost. This cannot be undone.
		</p>

		{#if deleteCountdownActive}
			<div class="modal-progress-wrapper">
				<div class="modal-progress-track">
					<div
						class="modal-progress-fill"
						style="width: {deleteProgress}%"
					></div>
				</div>
				<span class="modal-countdown">
					{#if deleteCountdown > 0}
						Deleting in {deleteCountdown}s...
					{:else}
						Deleting now...
					{/if}
				</span>
			</div>

			<div class="modal-actions">
				<button class="db-btn modal-btn-cancel" onclick={onCancelDelete}>
					Abort
				</button>
			</div>
		{:else}
			<div class="modal-actions">
				<button class="db-btn modal-btn-cancel" onclick={onCancelDelete}>
					Cancel
				</button>
				<button class="db-btn db-btn-danger modal-btn-delete" onclick={onStartDeleteCountdown}>
					<Trash2 class="h-4 w-4" />
					Delete
				</button>
			</div>
		{/if}
	</div>
</div>
