<script lang="ts">
	import { Modal, Button, Input } from '$lib/components/ui';

	let {
		open = $bindable(false),
		title = 'Rename',
		value = '',
		placeholder = 'Name',
		saving = false,
		onSave
	}: {
		open?: boolean;
		title?: string;
		value?: string;
		placeholder?: string;
		saving?: boolean;
		onSave: (name: string) => void;
	} = $props();

	let name = $state('');

	$effect(() => {
		if (open) name = value;
	});

	const canSave = $derived(!!name.trim() && name.trim() !== value);
</script>

<Modal bind:open {title} size="sm">
	<Input
		bind:value={name}
		{placeholder}
		onkeydown={(e: KeyboardEvent) => {
			if (e.key === 'Enter' && canSave && !saving) onSave(name.trim());
		}}
	/>
	{#snippet footer()}
		<Button variant="secondary" size="sm" disabled={saving} onclick={() => (open = false)}>
			Cancel
		</Button>
		<Button
			variant="primary"
			size="sm"
			loading={saving}
			disabled={!canSave}
			onclick={() => onSave(name.trim())}
		>
			Rename
		</Button>
	{/snippet}
</Modal>
