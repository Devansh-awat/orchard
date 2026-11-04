<script lang="ts">
	import { Check } from 'lucide-svelte';
	import { createQuery } from '@tanstack/svelte-query';
	import { Button, Field, Input, Select } from '@orchardlabs/graft-ui';
	import { sshIdentitiesQueryOptions } from '../../../lib/queries/sandboxes';
	import { getGreenhouseApp } from '../app.svelte';
	import { toasts } from '../../../host/stores';
	import type { Sandbox } from '../../../lib/types/sandbox';
	import FormError from '../FormError.svelte';
	import { hostOnly, type MachineWorkspace } from '../workspace.svelte';
	import Block from './Block.svelte';
	import { errorText, patchMachine } from './sections';

	let { machine, ws }: { machine: Sandbox; ws: MachineWorkspace } = $props();

	const owner = $derived(ws.isOwner);
	const app = getGreenhouseApp();
	const identities = createQuery(() => ({ ...sshIdentitiesQueryOptions(), enabled: owner }));
	let savingKey = $state(false);

	async function pickKey(id: string) {
		if (!owner || !id || id === machine.sshIdentity?.id) return;
		savingKey = true;
		try {
			await patchMachine(machine.id, { sshIdentityId: id });
		} catch (e) {
			toasts.add({ title: "Couldn't change the key", description: errorText(e), color: 'error' });
		} finally {
			savingKey = false;
		}
	}

	let name = $state('');
	let saved = $state(false);
	let saving = false;
	let editing = false;
	let seen: string | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const current = machine.name;
		if (current !== seen && !editing) name = current;
		seen = current;
	});

	$effect(() => () => {
		if (timer) clearTimeout(timer);
	});

	async function save() {
		editing = false;
		if (!owner || saving) return;
		const next = name.trim();
		if (!next || next === machine.name) {
			name = machine.name;
			return;
		}
		saving = true;
		try {
			await patchMachine(machine.id, { name: next });
			saved = true;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => (saved = false), 1600);
		} catch (e) {
			name = machine.name;
			toasts.add({ title: "Couldn't rename", description: errorText(e), color: 'error' });
		} finally {
			saving = false;
		}
	}

	function onkey(e: KeyboardEvent) {
		const input = e.currentTarget as HTMLInputElement;
		if (e.key === 'Enter') {
			e.preventDefault();
			input.blur();
		} else if (e.key === 'Escape' && name !== machine.name) {
			e.preventDefault();
			name = machine.name;
		}
	}
</script>

<Block>
	<Field label="Name" for="gh-settings-name" hint={owner ? undefined : hostOnly('rename it')}>
		<div class="name">
			<Input
				id="gh-settings-name"
				bind:value={name}
				maxlength={63}
				disabled={!owner}
				autocomplete="off"
				spellcheck="false"
				onfocus={() => (editing = true)}
				onblur={save}
				onkeydown={onkey}
			/>
			<span class="saved" aria-live="polite">
				{#if saved}<Check size={16} strokeWidth={1.75} aria-label="Saved" />{/if}
			</span>
		</div>
	</Field>
</Block>

<Block>
	<Field label="SSH key" for="gh-settings-key" hint={owner ? undefined : hostOnly('change it')}>
		<div class="name">
			{#if owner && (identities.data?.length ?? 0) > 0}
				<Select
					id="gh-settings-key"
					value={machine.sshIdentity?.id ?? ''}
					disabled={savingKey}
					onchange={(e: Event) => pickKey((e.currentTarget as HTMLSelectElement).value)}
				>
					{#if !machine.sshIdentity}<option value="" disabled>Choose a key</option>{/if}
					{#each identities.data ?? [] as identity (identity.id)}
						<option value={identity.id}>{identity.name}</option>
					{/each}
				</Select>
			{:else}
				<span class="value">{machine.sshIdentity?.name ?? 'None'}</span>
			{/if}
		</div>
	</Field>
</Block>

<Block>
	<div class="row">
		<span class="row-text">
			<span class="row-title">People</span>
			<span class="row-hint">Who can see and work on this machine</span>
		</span>
		<Button variant="secondary" size="sm" onclick={() => (app.sheet = 'share')}>
			{owner ? 'Manage' : 'View'}
		</Button>
	</div>
</Block>

{#if machine.applyError}
	<Block>
		<div class="apply">
			<FormError message="The last change failed to apply: {machine.applyError}" />
			<Button
				variant="secondary"
				size="sm"
				disabled={!ws.canLifecycle || !!ws.busy}
				onclick={() => ws.retryApply()}
			>
				{ws.busy === 'retry' ? 'Retrying…' : 'Retry'}
			</Button>
		</div>
	</Block>
{/if}

<style>
	.name {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 22rem;
	}

	.value {
		color: var(--gh-muted);
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.row-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.row-title {
		font-weight: 600;
	}

	.row-hint {
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}

	.saved {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 1rem;
		color: var(--status-success);
	}

	.apply {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}
</style>
