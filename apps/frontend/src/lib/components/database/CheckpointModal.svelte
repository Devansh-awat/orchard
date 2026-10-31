<script lang="ts">
	import { tick } from 'svelte';
	import { Flag } from 'lucide-svelte';
	import { Button, Field, Input, Modal, ModalIntro } from '$lib/components/ui';

	let {
		open = $bindable(false),
		saving = false,
		onsave
	}: {
		open?: boolean;
		saving?: boolean;
		onsave: (label: string) => void;
	} = $props();

	const uid = $props.id();
	let label = $state('');
	let wasOpen = false;

	$effect(() => {
		const isOpen = open;
		if (isOpen && !wasOpen) label = '';
		wasOpen = isOpen;
	});

	function focusOnOpen(el: HTMLInputElement) {
		void tick().then(() => el.focus());
	}

	function submit() {
		if (!saving) onsave(label.trim());
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
		<ModalIntro
			id="{uid}-title"
			icon={Flag}
			tone="accent"
			title="Take a checkpoint"
			description="A restore point you can come back to for 30 days."
		/>
		<Field label="Label" for="{uid}-label" hint="Optional">
			<Input
				id="{uid}-label"
				bind:value={label}
				placeholder="Before the users migration"
				maxlength={120}
				{@attach focusOnOpen}
			/>
		</Field>
	</form>
	{#snippet footer()}
		<Button variant="ghost" disabled={saving} onclick={() => (open = false)}>Cancel</Button>
		<Button variant="primary" loading={saving} onclick={submit}>Take checkpoint</Button>
	{/snippet}
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
</style>
