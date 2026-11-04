<script lang="ts">
	import { Button } from '@orchardlabs/graft-ui';
	import { toasts } from '../../../host/stores';
	import type { Sandbox } from '../../../lib/types/sandbox';
	import { hostOnly } from '../workspace.svelte';
	import Block from './Block.svelte';
	import { errorText, patchMachine } from './sections';

	let { machine, owner }: { machine: Sandbox; owner: boolean } = $props();

	let script = $state('');
	let saving = $state(false);
	let seen: string | null = null;

	const stored = $derived(machine.setupScript ?? '');
	const dirty = $derived(script !== stored);

	$effect(() => {
		const current = stored;
		if (current === seen) return;
		seen = current;
		script = current;
	});

	async function save() {
		if (!owner || saving || !dirty) return;
		saving = true;
		try {
			await patchMachine(machine.id, { setupScript: script.trim() ? script : null });
			toasts.add({ title: 'Setup script saved', color: 'success' });
		} catch (e) {
			toasts.add({
				title: "Couldn't save the setup script",
				description: errorText(e),
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}

	function onkey(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			void save();
		}
	}
</script>

<Block>
	<textarea
		class="script gh-mono"
		rows="14"
		bind:value={script}
		readonly={!owner}
		placeholder="apt-get install -y ripgrep"
		aria-label="Setup script"
		spellcheck="false"
		onkeydown={onkey}></textarea>
	<div class="actions">
		{#if owner}
			{#if dirty}
				<Button variant="ghost" size="sm" disabled={saving} onclick={() => (script = stored)}>
					Revert
				</Button>
			{/if}
			<Button variant="primary" size="sm" loading={saving} disabled={!dirty} onclick={save}>
				Save
			</Button>
		{:else}
			<p class="note">{hostOnly('edit it')}</p>
		{/if}
	</div>
</Block>

<style>
	.script {
		width: 100%;
		min-height: 12rem;
		padding: 0.5rem 0.75rem;
		border-radius: var(--gh-r-control);
		border: 1px solid var(--gh-line);
		background: var(--gh-field);
		color: var(--text-default);
		font-family: var(--gh-mono);
		font-size: var(--gh-ui);
		line-height: var(--gh-lh-ui);
		resize: vertical;
		outline: none;
		tab-size: 2;
	}

	.script::placeholder {
		color: var(--gh-faint);
	}

	.script:focus {
		border-color: var(--focus-ring-color);
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.script[readonly] {
		color: var(--gh-muted);
	}

	.actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.note {
		margin: 0;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}
</style>
