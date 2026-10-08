<script lang="ts">
	import { AlertTriangle, Trash2 } from 'lucide-svelte';
	import { Modal, Button, Input } from '$lib/components/ui';

	interface Props {
		open: boolean;
		title: string;
		description: string;
		html?: boolean;
		confirmLabel?: string;
		cancelLabel?: string;
		danger?: boolean;
		confirmText?: string | null;
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
		confirmText = null,
		onconfirm,
		oncancel
	}: Props = $props();

	let typed = $state('');
	let wasOpen = false;

	$effect(() => {
		if (open && !wasOpen) typed = '';
		wasOpen = open;
	});

	const confirmReady = $derived(!confirmText || typed.trim() === confirmText.trim());

	function handleCancel() {
		open = false;
		oncancel?.();
	}

	function handleConfirm() {
		if (!confirmReady) return;
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
		<p class="cm-desc">{@html description}</p>
	{:else}
		<p class="cm-desc">{description}</p>
	{/if}
	{#if confirmText}
		<form
			class="cm-confirm"
			onsubmit={(e) => {
				e.preventDefault();
				handleConfirm();
			}}
		>
			<label class="cm-confirm-label" for="cm-confirm-input">
				Type <strong>{confirmText}</strong> to confirm
			</label>
			<Input
				id="cm-confirm-input"
				bind:value={typed}
				placeholder={confirmText}
				autocomplete="off"
				spellcheck={false}
			/>
		</form>
	{/if}
	{#snippet footer()}
		<Button variant="secondary" onclick={handleCancel}>{cancelLabel}</Button>
		<Button
			variant={danger ? 'danger' : 'primary'}
			disabled={!confirmReady}
			onclick={handleConfirm}
		>
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
		border-radius: var(--radius-md);
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
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: 600;
		color: var(--text-default);
		margin: 0 0 0.5rem;
	}

	.cm-desc {
		font-size: var(--text-footnote);
		color: var(--text-muted);
		margin: 0;
		line-height: 1.5;
	}

	.cm-desc :global(strong) {
		color: var(--status-error);
		font-weight: 600;
	}

	.cm-confirm {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin-top: 1rem;
	}

	.cm-confirm-label {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.cm-confirm-label strong {
		color: var(--text-default);
		font-weight: 600;
		font-family: var(--font-mono);
	}
</style>
