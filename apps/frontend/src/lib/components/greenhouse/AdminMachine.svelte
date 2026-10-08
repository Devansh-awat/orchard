<script lang="ts">
	import { Lock, Play, RotateCw, Square, Trash2 } from 'lucide-svelte';
	import { Button, Input, Modal } from '$lib/components/ui';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import { sandboxStatus } from '$lib/components/ui/status';
	import { queryClient } from '$lib/query';
	import { toasts } from '$lib/stores';
	import * as api from './api';
	import { getGreenhouseApp } from './app.svelte';
	import { ago, runnerLabel } from './format';
	import type { MachineWorkspace } from './workspace.svelte';

	let { ws }: { ws: MachineWorkspace } = $props();

	const app = getGreenhouseApp();
	const machine = $derived(ws.machine);
	const meta = $derived(
		machine
			? sandboxStatus(machine.status, {
					applying: machine.applying,
					applyError: machine.applyError,
					desiredState: machine.desiredState
				})
			: null
	);
	const host = $derived(machine?.owner?.username ?? machine?.owner?.email ?? 'another member');
	const stopped = $derived(machine?.status === 'stopped' || machine?.status === 'error');
	const transitional = $derived(
		machine ? ['creating', 'starting', 'stopping', 'deleting'].includes(machine.status) : false
	);

	let confirmOpen = $state(false);
	let confirmName = $state('');
	let deleting = $state(false);

	function askDelete() {
		confirmName = '';
		confirmOpen = true;
	}

	async function remove() {
		const target = machine;
		if (!target || deleting || confirmName !== target.name) return;
		deleting = true;
		try {
			await api.deleteSandbox(target.id);
			await queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
			confirmOpen = false;
			toasts.add({ title: `Deleting ${target.name}`, color: 'success' });
			app.nav.go({ machine: null, session: null, tab: null });
		} catch (e) {
			toasts.add({
				title: 'Delete failed',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			deleting = false;
		}
	}
</script>

<div class="admin">
	<EmptyState
		title="Only the host and people they invite can open this machine"
		description="{machine?.name ??
			'This machine'} belongs to {host}. As an admin of this organization you can start, stop or delete it, but its files, sessions and terminals stay private."
	>
		{#snippet icon()}<Lock size={20} strokeWidth={1.75} />{/snippet}
		{#if machine && meta}
			<p class="facts">
				<span class="state"><StatusDot {meta} size={8} /> {meta.label}</span>
				<span>{runnerLabel(machine.runner)}</span>
				{#if machine.lastActiveAt}<span>active {ago(machine.lastActiveAt)}</span>{/if}
			</p>
			{#if machine.applyError}
				<p class="apply">The last change failed to apply: {machine.applyError}</p>
			{/if}
			<div class="actions">
				{#if machine.applyError}
					<button type="button" class="gh-btn" disabled={!!ws.busy} onclick={() => ws.retryApply()}>
						<RotateCw size={14} strokeWidth={1.75} />
						{ws.busy === 'retry' ? 'Retrying…' : 'Retry'}
					</button>
				{/if}
				{#if stopped}
					<button
						type="button"
						class="gh-btn"
						disabled={!ws.canStart || !!ws.busy}
						onclick={() => ws.lifecycle('start')}
					>
						<Play size={14} strokeWidth={1.75} />
						{ws.busy === 'start' ? 'Starting…' : 'Start'}
					</button>
				{:else}
					<button
						type="button"
						class="gh-btn"
						disabled={!ws.canLifecycle || !!ws.busy || transitional}
						onclick={() => ws.lifecycle('stop')}
					>
						<Square size={14} strokeWidth={1.75} />
						{ws.busy === 'stop' ? 'Stopping…' : 'Stop'}
					</button>
				{/if}
				<button
					type="button"
					class="gh-btn gh-btn--ghost"
					disabled={!ws.canLifecycle || machine.status === 'deleting'}
					onclick={askDelete}
				>
					<Trash2 size={14} strokeWidth={1.75} /> Delete…
				</button>
			</div>
		{/if}
	</EmptyState>
</div>

<Modal bind:open={confirmOpen} title="Delete {machine?.name ?? 'machine'}" size="sm">
	<div class="confirm">
		<p class="confirm-text">
			Its disk, worktrees and unpushed branches are removed for {host} too. Type
			<strong>{machine?.name}</strong> to confirm.
		</p>
		<Input bind:value={confirmName} placeholder={machine?.name} aria-label="Machine name" />
	</div>
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (confirmOpen = false)}>Cancel</Button>
		<Button
			variant="danger"
			disabled={!machine || confirmName !== machine.name || deleting}
			onclick={remove}
		>
			{deleting ? 'Deleting…' : 'Delete'}
		</Button>
	{/snippet}
</Modal>

<style>
	.admin {
		display: flex;
		flex: 1;
		align-items: center;
		justify-content: center;
		min-height: 0;
		padding: 2rem var(--gh-edge);
	}

	.admin :global(.ui-empty) {
		gap: 0.5rem;
		max-width: 32rem;
		padding: 0;
	}

	.admin :global(.ui-empty-icon) {
		width: 3rem;
		height: 3rem;
		border-radius: var(--gh-r-row);
		background: var(--gh-field);
		color: var(--gh-muted);
	}

	.admin :global(.ui-empty-title) {
		margin: 0;
		font-size: var(--gh-reading);
		line-height: var(--gh-lh-reading);
		font-weight: 600;
		color: var(--gh-text);
	}

	.admin :global(.ui-empty-desc) {
		margin: 0;
		max-width: 28rem;
		font-size: var(--gh-ui);
		line-height: var(--gh-lh-ui);
		color: var(--gh-muted);
	}

	.admin :global(.ui-empty-action) {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		margin-top: 0.5rem;
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.25rem 0.75rem;
		margin: 0;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}

	.state {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--gh-text);
	}

	.apply {
		margin: 0;
		max-width: 28rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.5rem;
	}

	.confirm {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.confirm-text {
		margin: 0;
		color: var(--text-default);
	}
</style>
