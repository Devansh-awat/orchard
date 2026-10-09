<script lang="ts">
	import { Button, Modal } from '$lib/components/ui';
	import { getGreenhouseApp } from './app.svelte';
	import { acknowledgeJoin, guestDisclosure, joinAcknowledged } from './disclosure';

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const machine = $derived(app.machine);
	const guest = $derived(ws?.role === 'collaborator' || ws?.role === 'viewer');
	const readOnly = $derived(ws?.role === 'viewer');
	const host = $derived(
		ws?.members?.owner?.name ?? machine?.owner?.username ?? machine?.owner?.email ?? 'the host'
	);
	const userId = $derived(app.self?.id ?? null);

	let open = $state(false);

	$effect(() => {
		const id = machine?.id;
		if (!id || !userId || !guest) {
			open = false;
			return;
		}
		open = !joinAcknowledged(userId, id);
	});

	function proceed() {
		if (machine && userId) acknowledgeJoin(userId, machine.id);
		open = false;
	}
</script>

<Modal bind:open title={machine?.name ?? 'Joining'} size="sm" closable={false}>
	<p class="text">{guestDisclosure(host, readOnly)}</p>
	{#snippet footer()}
		<Button variant="primary" onclick={proceed}>Continue</Button>
	{/snippet}
</Modal>

<style>
	.text {
		margin: 0;
		color: var(--text-default);
	}
</style>
