<script lang="ts">
	import { tick } from 'svelte';
	import { PenLine, ArrowRight } from 'lucide-svelte';
	import { Modal, Button, Input, Field } from '$lib/components/ui';

	let {
		open = $bindable(false),
		title = 'Rename',
		label = 'Name',
		value = '',
		placeholder = 'Name',
		saving = false,
		onSave
	}: {
		open?: boolean;
		title?: string;
		label?: string;
		value?: string;
		placeholder?: string;
		saving?: boolean;
		onSave: (name: string) => void;
	} = $props();

	let name = $state('');

	$effect(() => {
		if (open) name = value;
	});

	const next = $derived(name.trim());
	const canSave = $derived(!!next && next !== value);

	function focusOnOpen(el: HTMLInputElement) {
		void tick().then(() => {
			el.focus();
			el.select();
		});
	}

	function submit() {
		if (canSave && !saving) onSave(next);
	}
</script>

<Modal bind:open size="sm">
	{#snippet header()}
		<div class="rn-icon">
			<PenLine size={18} />
		</div>
	{/snippet}
	<h2 class="rn-title">{title}</h2>
	<form
		class="rn-form"
		onsubmit={(e) => {
			e.preventDefault();
			submit();
		}}
	>
		<Field {label} for="rename-input">
			<Input id="rename-input" bind:value={name} {placeholder} {@attach focusOnOpen} />
		</Field>
		<p class="rn-preview" class:rn-preview--live={canSave} aria-live="polite">
			<span class="rn-preview-from">{value}</span>
			<ArrowRight size={12} aria-hidden="true" />
			<span class="rn-preview-to">{canSave ? next : value}</span>
		</p>
	</form>
	{#snippet footer()}
		<Button variant="secondary" size="sm" disabled={saving} onclick={() => (open = false)}>
			Cancel
		</Button>
		<Button variant="primary" size="sm" loading={saving} disabled={!canSave} onclick={submit}>
			Rename
		</Button>
	{/snippet}
</Modal>

<style>
	.rn-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--radius-md);
		background: var(--accent-subtle);
		color: var(--accent);
	}
	.rn-title {
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text-default);
		margin: 0;
	}
	.rn-form {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		margin-top: 0.75rem;
	}
	.rn-preview {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		min-height: 1.25rem;
		margin: 0;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--surface-muted);
		opacity: 0;
		transform: translateY(2px);
		transition:
			opacity var(--dur-fast) ease,
			transform var(--dur-fast) ease;
	}
	.rn-preview--live {
		opacity: 1;
		transform: none;
	}
	.rn-preview-from {
		text-decoration: line-through;
		text-decoration-color: color-mix(in srgb, currentColor 50%, transparent);
	}
	.rn-preview-to {
		color: var(--text-default);
		font-weight: 600;
	}
</style>
