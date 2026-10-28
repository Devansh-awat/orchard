<script lang="ts">
	import { tick } from 'svelte';
	import { PenLine } from 'lucide-svelte';
	import { Modal, ModalIntro, Button, Input, Field } from '$lib/components/ui';

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

	const uid = $props.id();
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

<Modal bind:open size="sm" closable={false} dismissable labelledby="{uid}-title">
	<form
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			submit();
		}}
	>
		<ModalIntro id="{uid}-title" icon={PenLine} {title} />
		<Field {label} for="{uid}-input">
			<Input id="{uid}-input" bind:value={name} {placeholder} {@attach focusOnOpen} />
		</Field>
	</form>
	{#snippet footer()}
		<Button variant="ghost" disabled={saving} onclick={() => (open = false)}>Cancel</Button>
		<Button variant="primary" loading={saving} disabled={!canSave} onclick={submit}>Rename</Button>
	{/snippet}
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
</style>
