<script lang="ts">
	import { Button, Field, Input, Modal } from '@orchard/graft-ui';
	import { queryClient } from '../../host/query';
	import { toasts } from '../../host/stores';
	import * as api from './api';
	import FormError from './FormError.svelte';
	import { getGreenhouseApp } from './app.svelte';
	import { runnerLabel } from './format';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const app = getGreenhouseApp();
	const machine = $derived(app.machine);
	const ws = $derived(app.ws);
	const runner = $derived(app.runners.find((r) => r.id === machine?.runner) ?? null);
	const snapshot = $derived(runner?.capabilities.persistence === 'snapshot');

	let name = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen && machine) {
			name = `${machine.name}-fork`.slice(0, 63);
			error = null;
		}
		wasOpen = open;
	});

	const valid = $derived(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name.trim()));

	async function fork() {
		if (!machine || !ws?.isOwner || busy || !valid) return;
		busy = true;
		error = null;
		try {
			const created = await api.forkMachine(machine.id, name.trim());
			await queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
			open = false;
			toasts.add({ title: `Forking ${machine.name} into ${created.name}`, color: 'success' });
			app.openMachine(created.id);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not fork the machine';
		} finally {
			busy = false;
		}
	}
</script>

<Modal bind:open title="Fork {machine?.name ?? 'machine'}" size="sm">
	{#if machine}
		<div class="form">
			<p class="lead">
				{#if snapshot}
					Forks the last saved state. Stop the machine first to include recent changes.
				{:else}
					Copies the home volume from a snapshot.
				{/if}
				The fork is yours alone, with its own {runnerLabel(machine.runner)} machine, its sessions and
				nobody invited.
			</p>
			<Field label="Name" for="gh-fork-name" hint="Lowercase letters, numbers and dashes">
				<Input
					id="gh-fork-name"
					bind:value={name}
					maxlength={63}
					onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && fork()}
				/>
			</Field>
			{#if error}<FormError message={error} />{/if}
		</div>
	{/if}
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (open = false)}>Cancel</Button>
		<Button variant="primary" disabled={!ws?.isOwner || busy || !valid} onclick={fork}>
			{busy ? 'Forking…' : 'Fork machine'}
		</Button>
	{/snippet}
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.lead {
		margin: 0;
	}

	.lead {
		color: var(--text-muted);
	}
</style>
