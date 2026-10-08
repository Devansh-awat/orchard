<script lang="ts">
	import {
		Check,
		ChevronDown,
		Code,
		Copy,
		MousePointer2,
		SquareTerminal,
		Zap
	} from 'lucide-svelte';
	import type { Component } from 'svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import PopoverPanel from '$lib/components/ui/PopoverPanel.svelte';
	import { toasts } from '$lib/stores';
	import { getGreenhouseApp } from './app.svelte';
	import type { EditorTarget } from './types';
	import { hostOnly } from './workspace.svelte';

	const STORAGE = 'greenhouse-open-in';
	const SETUP = 'orchard sandbox ssh-config --install';

	const TARGETS: { id: EditorTarget; label: string; icon: Component }[] = [
		{ id: 'vscode', label: 'VS Code', icon: Code },
		{ id: 'cursor', label: 'Cursor', icon: MousePointer2 },
		{ id: 'zed', label: 'Zed', icon: Zap },
		{ id: 'terminal', label: 'Terminal', icon: SquareTerminal }
	];

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const machine = $derived(app.machine);
	const session = $derived(ws?.session ?? null);
	const host = $derived(ws?.connect?.sshHost ?? (machine ? `orchard-${machine.name}` : ''));
	const ready = $derived(ws?.connect?.sshReady === true);
	const owner = $derived(ws?.isOwner ?? false);

	let last = $state<EditorTarget>(readLast());
	let menuOpen = $state(false);
	let setupOpen = $state(false);
	let copied = $state(false);

	const primary = $derived(TARGETS.find((t) => t.id === last) ?? TARGETS[0]);

	function readLast(): EditorTarget {
		if (typeof localStorage === 'undefined') return 'vscode';
		const saved = localStorage.getItem(STORAGE) as EditorTarget | null;
		return saved && TARGETS.some((t) => t.id === saved) ? saved : 'vscode';
	}

	function remember(target: EditorTarget) {
		last = target;
		try {
			localStorage.setItem(STORAGE, target);
		} catch {
			return;
		}
	}

	function urlFor(target: EditorTarget): string | null {
		const path = session?.worktreePath ?? '/persist/home';
		if (target === 'vscode') return `vscode://vscode-remote/ssh-remote+${host}${path}`;
		if (target === 'cursor') return `cursor://vscode-remote/ssh-remote+${host}${path}`;
		if (target === 'zed') return `zed://ssh/${host}${path}`;
		return null;
	}

	async function launch(target: EditorTarget) {
		if (!owner || !machine) return;
		remember(target);
		if (target === 'terminal') {
			await navigator.clipboard.writeText(`ssh ${host}`);
			toasts.add({ title: 'SSH command copied', description: `ssh ${host}`, color: 'success' });
			if (!ready) setupOpen = true;
			return;
		}
		if (!ready) {
			setupOpen = true;
			return;
		}
		const url = urlFor(target);
		if (url) window.location.href = url;
	}

	async function copySetup() {
		await navigator.clipboard.writeText(SETUP);
		copied = true;
		setTimeout(() => (copied = false), 1400);
	}
</script>

<div class="openin">
	<div class="gh-split" role="group" aria-label="Open in editor">
		<button
			type="button"
			disabled={!owner || !machine}
			title={owner ? `Open in ${primary.label}` : hostOnly('open editors over SSH')}
			onclick={() => launch(primary.id)}
		>
			<primary.icon size={14} strokeWidth={1.75} />
			<span class="label">{primary.label}</span>
		</button>
		<Menu bind:open={menuOpen} placement="bottom-end">
			{#snippet trigger(menuProps, isOpen)}
				<button
					{...menuProps}
					type="button"
					aria-label="Choose an editor"
					aria-expanded={isOpen}
					disabled={!owner || !machine}
				>
					<ChevronDown size={14} strokeWidth={1.75} />
				</button>
			{/snippet}
			<div class="gh-menu-head">Open in</div>
			{#each TARGETS as target (target.id)}
				<MenuItem onclick={() => launch(target.id)}>
					<target.icon size={14} />
					<span>{target.id === 'terminal' ? 'Copy SSH command' : target.label}</span>
					{#if target.id === last}<span class="gh-menu-kbd"><Check size={13} /></span>{/if}
				</MenuItem>
			{/each}
		</Menu>
	</div>
	<PopoverPanel bind:open={setupOpen} placement="bottom-end" class="openin-setup">
		{#snippet trigger(props)}
			<span {...props} class="anchor" aria-hidden="true" tabindex="-1"></span>
		{/snippet}
		<div class="setup">
			<p class="setup-title">One-time setup on your computer</p>
			<p class="setup-text">
				Editors reach {machine?.name ?? 'this machine'} over SSH through the Orchard CLI. Run this once,
				then try again.
			</p>
			<div class="setup-cmd">
				<code class="gh-mono">{SETUP}</code>
				<button type="button" class="gh-ibtn" aria-label="Copy command" onclick={copySetup}>
					{#if copied}<Check size={14} />{:else}<Copy size={14} />{/if}
				</button>
			</div>
		</div>
	</PopoverPanel>
</div>

<style>
	.openin {
		position: relative;
		display: inline-flex;
	}

	.anchor {
		position: absolute;
		right: 0;
		bottom: 0;
		width: 1px;
		height: 1px;
		pointer-events: none;
	}

	.label {
		max-width: 6rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.setup {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: 22rem;
		padding: 0.25rem;
	}

	.setup-title {
		margin: 0;
		font-weight: 600;
		color: var(--gh-text);
	}

	.setup-text {
		margin: 0;
		color: var(--gh-muted);
		font-size: var(--gh-caption);
		line-height: var(--lh-caption);
	}

	.setup-cmd {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem 0.25rem 0.25rem 0.625rem;
		border-radius: var(--radius-xs);
		border: 1px solid var(--gh-line);
		background: var(--gh-field);
	}

	.setup-cmd code {
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		white-space: nowrap;
		font-size: var(--gh-caption);
	}
</style>
