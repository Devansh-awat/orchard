<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { AlertTriangle, X, Trash2 } from 'lucide-svelte';

	interface Props {
		open: boolean;
		title: string;
		description: string;
		confirmLabel?: string;
		cancelLabel?: string;
		danger?: boolean;
		onconfirm: () => void;
		oncancel: () => void;
	}

	let {
		open = $bindable(false),
		title,
		description,
		confirmLabel = 'Delete',
		cancelLabel = 'Cancel',
		danger = true,
		onconfirm,
		oncancel
	}: Props = $props();

	function handleCancel() {
		open = false;
		oncancel?.();
	}

	function handleConfirm() {
		open = false;
		onconfirm?.();
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="cm-overlay" transition:fade={{ duration: 150 }} onclick={handleCancel}>
		<div
			class="cm-card"
			transition:scale={{ duration: 200, start: 0.95 }}
			onclick={(e) => e.stopPropagation()}
		>
			<div class="cm-header">
				<div class="cm-icon" class:cm-icon-danger={danger} class:cm-icon-neutral={!danger}>
					<AlertTriangle size={20} />
				</div>
				<button class="cm-close" onclick={handleCancel}>
					<X size={16} />
				</button>
			</div>

			<h2 class="cm-title">{title}</h2>
			<p class="cm-desc">{@html description}</p>

			<div class="cm-actions">
				<button class="cm-btn cm-btn-cancel" onclick={handleCancel}>
					{cancelLabel}
				</button>
				<button
					class="cm-btn"
					class:cm-btn-danger={danger}
					class:cm-btn-primary={!danger}
					onclick={handleConfirm}
				>
					{#if danger}
						<Trash2 class="h-4 w-4" />
					{/if}
					{confirmLabel}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.cm-overlay {
		position: fixed;
		inset: 0;
		background-color: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 1rem;
	}

	.cm-card {
		background-color: var(--center-channel-bg);
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		padding: 1.5rem;
		width: 100%;
		max-width: 26rem;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
	}

	.cm-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		margin-bottom: 1rem;
	}

	.cm-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.75rem;
	}

	.cm-icon-danger {
		background-color: color-mix(in srgb, var(--error-text-color) 12%, transparent);
		color: var(--error-text-color);
	}

	.cm-icon-neutral {
		background-color: color-mix(in srgb, #f59e0b 12%, transparent);
		color: #f59e0b;
	}

	.cm-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		transition: color 0.15s, background-color 0.15s;
	}

	.cm-close:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.cm-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0 0 0.5rem;
	}

	.cm-desc {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0 0 1.25rem;
		line-height: 1.5;
	}

	.cm-desc :global(strong) {
		color: var(--error-text-color);
		font-weight: 600;
	}

	.cm-actions {
		display: flex;
		gap: 0.5rem;
		justify-content: flex-end;
	}

	.cm-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 1rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 500;
		border: none;
		cursor: pointer;
		transition: opacity 0.15s;
	}

	.cm-btn-cancel {
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: var(--center-channel-color);
	}

	.cm-btn-cancel:hover {
		background-color: color-mix(in srgb, var(--surface-border) 90%, transparent);
	}

	.cm-btn-danger {
		background-color: color-mix(in srgb, var(--error-text-color) 15%, transparent);
		color: var(--error-text-color);
	}

	.cm-btn-danger:hover {
		opacity: 0.85;
	}

	.cm-btn-primary {
		background-color: var(--sidebar-text-active-border);
		color: #fff;
	}

	.cm-btn-primary:hover {
		opacity: 0.9;
	}
</style>
