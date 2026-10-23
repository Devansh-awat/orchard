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

	const uid = $props.id();

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

<Modal bind:open size="sm" closable={false} dismissable onclose={() => oncancel?.()}>
	<div class="confirm">
		<div class="tile" class:tile--danger={danger} aria-hidden="true">
			{#if danger}<Trash2 size={18} />{:else}<AlertTriangle size={18} />{/if}
		</div>
		<div class="copy">
			<h2 class="title">{title}</h2>
			{#if html}
				<p class="desc">{@html description}</p>
			{:else}
				<p class="desc">{description}</p>
			{/if}
		</div>
		{#if confirmText}
			<form
				class="type"
				onsubmit={(e) => {
					e.preventDefault();
					handleConfirm();
				}}
			>
				<label class="type-label" for="{uid}-confirm">
					Type <code class="type-code">{confirmText}</code> to confirm
				</label>
				<Input
					id="{uid}-confirm"
					bind:value={typed}
					placeholder={confirmText}
					autocomplete="off"
					spellcheck={false}
				/>
			</form>
		{/if}
	</div>
	{#snippet footer()}
		<Button variant="secondary" onclick={handleCancel}>{cancelLabel}</Button>
		<Button
			variant={danger ? 'danger' : 'primary'}
			disabled={!confirmReady}
			onclick={handleConfirm}
		>
			{confirmLabel}
		</Button>
	{/snippet}
</Modal>

<style>
	.confirm {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.tile {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--radius-card);
		background: var(--amber-3);
		color: var(--amber-9);
		box-shadow: inset 0 0 0 1px var(--amber-4);
	}
	.tile--danger {
		background: var(--red-3);
		color: var(--red-9);
		box-shadow: inset 0 0 0 1px var(--red-4);
	}
	.copy {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.title {
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--track-headline);
		color: var(--text-default);
	}
	.desc {
		font-size: var(--text-callout);
		line-height: 1.25rem;
		color: var(--text-muted);
		text-wrap: pretty;
	}
	.desc :global(strong) {
		color: var(--text-default);
		font-weight: var(--weight-semibold);
	}
	.desc :global(code) {
		font-family: var(--font-mono);
		font-size: 0.92em;
		color: var(--text-default);
	}
	.type {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.type-label {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.type-code {
		padding: 0.0625rem 0.3125rem;
		border-radius: 0.3125rem;
		background: var(--bg-active);
		color: var(--text-default);
		font-family: var(--font-mono);
		font-size: 0.92em;
	}
</style>
