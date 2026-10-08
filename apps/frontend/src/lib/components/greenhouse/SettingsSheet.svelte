<script lang="ts">
	import { Button, Field, Input, Modal } from '$lib/components/ui';
	import { queryClient } from '$lib/query';
	import { apiFetch, toasts } from '$lib/stores';
	import * as api from './api';
	import { getGreenhouseApp } from './app.svelte';
	import { ago, runnerLabel } from './format';
	import FormError from './FormError.svelte';
	import ProjectLinks from './ProjectLinks.svelte';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const app = getGreenhouseApp();
	const machine = $derived(app.machine);
	const ws = $derived(app.ws);
	const owner = $derived(ws?.isOwner ?? false);

	let name = $state('');
	let setup = $state('');
	let saving = $state(false);
	let confirmName = $state('');
	let deleting = $state(false);

	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen && machine) {
			name = machine.name;
			setup = machine.setupScript ?? '';
			confirmName = '';
		}
		wasOpen = open;
	});

	async function save() {
		if (!machine || saving) return;
		saving = true;
		try {
			const res = await apiFetch(`/apiv1/sandboxes/${machine.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					...(name.trim() && name.trim() !== machine.name ? { name: name.trim() } : {}),
					setupScript: setup.trim() ? setup : null
				})
			});
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Save failed');
			await queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
			toasts.add({ title: 'Machine settings saved', color: 'success' });
			open = false;
		} catch (e) {
			toasts.add({
				title: 'Could not save',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}

	async function remove() {
		if (!machine || deleting || confirmName !== machine.name) return;
		deleting = true;
		try {
			await api.deleteSandbox(machine.id);
			await queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
			open = false;
			toasts.add({ title: `Deleting ${machine.name}`, color: 'success' });
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

<Modal bind:open title="Machine settings" size="md">
	{#if machine}
		<div class="form">
			<p class="facts">
				{runnerLabel(machine.runner)}{machine.diskObserved ? ` · ${machine.diskObserved} disk` : ''} ·
				created {ago(machine.createdAt)}
				{#if machine.lastActiveAt}· active {ago(machine.lastActiveAt)}{/if}
			</p>
			<Field label="Name" for="gh-set-name">
				<Input id="gh-set-name" bind:value={name} maxlength={63} disabled={!owner} />
			</Field>
			<Field label="Setup script" hint="Runs once, on the machine's first boot" for="gh-set-setup">
				<textarea
					id="gh-set-setup"
					class="script gh-mono"
					rows="4"
					bind:value={setup}
					disabled={!owner}></textarea>
			</Field>
			{#if machine.applyError}
				<div class="apply">
					<FormError message="The last change failed to apply: {machine.applyError}" />
					<Button
						variant="secondary"
						size="sm"
						disabled={!ws?.canLifecycle || !!ws?.busy}
						onclick={() => ws?.retryApply()}
					>
						{ws?.busy === 'retry' ? 'Retrying…' : 'Retry'}
					</Button>
				</div>
			{/if}
			<ProjectLinks active={open} />
			{#if owner}
				<div class="danger">
					<p class="danger-title">Delete this machine</p>
					<p class="danger-text">
						Its disk, worktrees and unpushed branches are removed. Type <strong
							>{machine.name}</strong
						> to confirm.
					</p>
					<div class="danger-row">
						<Input bind:value={confirmName} placeholder={machine.name} aria-label="Machine name" />
						<Button
							variant="danger"
							disabled={confirmName !== machine.name || deleting}
							onclick={remove}
						>
							{deleting ? 'Deleting…' : 'Delete'}
						</Button>
					</div>
				</div>
			{/if}
		</div>
	{/if}
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (open = false)}>Cancel</Button>
		<Button variant="primary" disabled={!owner || saving} onclick={save}
			>{saving ? 'Saving…' : 'Save'}</Button
		>
	{/snippet}
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.facts {
		margin: 0;
		font-size: var(--text-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-muted);
	}

	.script {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border-radius: var(--gh-r-control);
		border: 1px solid var(--border-default);
		background: var(--bg-app);
		color: var(--text-default);
		font-size: var(--text-caption);
		line-height: var(--gh-lh-caption);
		resize: vertical;
		outline: none;
	}

	.script:focus {
		border-color: var(--focus-ring-color);
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.apply {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.danger {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem 1rem 1rem;
		border-radius: var(--gh-r-row);
		border: 1px solid color-mix(in oklab, var(--status-error) 30%, var(--border-default));
		background: color-mix(in oklab, var(--status-error) 5%, transparent);
	}

	.danger-title {
		margin: 0;
		font-weight: 600;
		font-size: var(--text-footnote);
	}

	.danger-text {
		margin: 0;
		font-size: var(--text-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-muted);
	}

	.danger-row {
		display: flex;
		gap: 0.5rem;
	}
</style>
