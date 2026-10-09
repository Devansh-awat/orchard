<script lang="ts">
	import { Check } from 'lucide-svelte';
	import { Button, Field, Input } from '$lib/components/ui';
	import { toasts } from '$lib/stores';
	import type { Sandbox } from '$lib/types/sandbox';
	import FormError from '../FormError.svelte';
	import { hostOnly, type MachineWorkspace } from '../workspace.svelte';
	import Block from './Block.svelte';
	import { errorText, patchMachine } from './sections';

	let { machine, ws }: { machine: Sandbox; ws: MachineWorkspace } = $props();

	const owner = $derived(ws.isOwner);

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
			toasts.add({ title: 'Could not rename', description: errorText(e), color: 'error' });
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
