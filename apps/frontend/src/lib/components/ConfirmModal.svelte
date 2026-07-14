<script lang="ts">
	import { AlertTriangle, Trash2 } from 'lucide-svelte';
	import { Modal, Button } from '$lib/components/ui';

	interface Props {
		open: boolean;
		title: string;
		description: string;
		html?: boolean;
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
		html = false,
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

<Modal bind:open size="sm" onclose={() => oncancel?.()}>
	{#snippet header()}
		<div class="cm-icon" class:cm-icon-danger={danger} class:cm-icon-neutral={!danger}>
			<AlertTriangle size={20} />
		</div>
	{/snippet}
	<h2 class="cm-title">{title}</h2>
	{#if html}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		<p class="cm-desc">{@html description}</p>
	{:else}
		<p class="cm-desc">{description}</p>
	{/if}
	{#snippet footer()}
		<Button variant="secondary" onclick={handleCancel}>{cancelLabel}</Button>
		<Button variant={danger ? 'danger' : 'primary'} onclick={handleConfirm}>
			{#if danger}
				<Trash2 class="h-4 w-4" />
			{/if}
			{confirmLabel}
		</Button>
	{/snippet}
</Modal>

<style>
	.cm-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.75rem;
	}

	.cm-icon-danger {
		background-color: color-mix(in srgb, var(--status-error) 12%, transparent);
		color: var(--status-error);
	}

	.cm-icon-neutral {
		background-color: color-mix(in srgb, var(--status-warning) 12%, transparent);
		color: var(--status-warning);
	}

	.cm-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-default);
		margin: 0 0 0.5rem;
	}

	.cm-desc {
		font-size: 0.8125rem;
		color: var(--text-muted);
		margin: 0;
		line-height: 1.5;
	}

	.cm-desc :global(strong) {
		color: var(--status-error);
		font-weight: 600;
	}
</style>
