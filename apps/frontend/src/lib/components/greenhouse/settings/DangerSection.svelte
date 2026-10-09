<script lang="ts">
	import { Button, Field, Input } from '$lib/components/ui';
	import { queryClient } from '$lib/query';
	import { toasts } from '$lib/stores';
	import type { Sandbox } from '$lib/types/sandbox';
	import * as api from '../api';
	import { getGreenhouseApp } from '../app.svelte';
	import Block from './Block.svelte';
	import { errorText } from './sections';

	let { machine, onclose }: { machine: Sandbox; onclose: () => void } = $props();

	const app = getGreenhouseApp();

	let confirm = $state('');
	let deleting = $state(false);

	const armed = $derived(confirm === machine.name && !deleting);

	async function remove() {
		if (!armed) return;
		deleting = true;
		const name = machine.name;
		try {
			await api.deleteSandbox(machine.id);
			await queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
			onclose();
			toasts.add({ title: `Deleting ${name}`, color: 'success' });
			app.nav.go({ machine: null, session: null, tab: null });
		} catch (e) {
			toasts.add({ title: 'Delete failed', description: errorText(e), color: 'error' });
		} finally {
			deleting = false;
		}
	}
</script>

<Block>
	<Field
		label="Delete machine"
		for="gh-settings-delete"
		hint="Removes its disk and any unpushed work."
	>
		<div class="confirm">
			<Input
				id="gh-settings-delete"
				bind:value={confirm}
				placeholder="Type {machine.name} to confirm"
				autocomplete="off"
				spellcheck="false"
				onkeydown={(e: KeyboardEvent) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						void remove();
					}
				}}
			/>
			<Button variant="danger" size="sm" loading={deleting} disabled={!armed} onclick={remove}>
				Delete
			</Button>
		</div>
	</Field>
</Block>

<style>
	.confirm {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 26rem;
	}
</style>
