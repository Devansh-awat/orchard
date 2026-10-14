<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { Github, Plus, Terminal, Trash2 } from 'lucide-svelte';
	import { apiFetch, toasts } from '../../host/stores';
	import { queryClient } from '../../host/query';
	import { Button, Field, Input, Skeleton } from '@orchardlabs/graft-ui';
	import ConfirmModal from '@orchardlabs/graft-ui/components/ConfirmModal.svelte';
	import { timeAgo } from '../../lib/utils/time';
	import { sshIdentitiesQueryOptions } from '../../lib/queries/sandboxes';
	import type { SshIdentity } from '../../lib/types/sandbox';
	import SettingsSection from './SettingsSection.svelte';

	let { index = 0 }: { index?: number } = $props();

	const identitiesQuery = createQuery(() => sshIdentitiesQueryOptions());
	const identities = $derived(identitiesQuery.data ?? []);

	let showAdd = $state(false);
	let newName = $state('');
	let newKey = $state('');
	let adding = $state(false);
	let importing = $state(false);
	let deletingId = $state<string | null>(null);
	let deleteTarget = $state<SshIdentity | null>(null);
	let deleteConfirmOpen = $state(false);

	function invalidate() {
		queryClient.invalidateQueries({ queryKey: ['ssh-identities'] });
	}

	function keyLabel(publicKey: string): string {
		const [type, body] = publicKey.trim().split(/\s+/);
		if (!body) return publicKey.slice(0, 24);
		return `${type} …${body.slice(-12)}`;
	}

	async function addIdentity() {
		if (adding || !newName.trim() || !newKey.trim()) return;
		adding = true;
		try {
			const res = await apiFetch('/apiv1/ssh-identities', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newName.trim(), publicKey: newKey.trim() })
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || 'Failed to add identity');
			}
			newName = '';
			newKey = '';
			showAdd = false;
			invalidate();
			toasts.add({ title: 'Identity added', color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to add identity',
				color: 'error'
			});
		} finally {
			adding = false;
		}
	}

	async function importFromGithub() {
		if (importing) return;
		importing = true;
		try {
			const res = await apiFetch('/apiv1/ssh-identities/import-github', { method: 'POST' });
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || 'Failed to import GitHub keys');
			}
			const data = await res.json();
			const count = data?.identities?.length ?? 0;
			invalidate();
			toasts.add({
				title:
					count > 0 ? `Imported ${count} ${count === 1 ? 'key' : 'keys'}` : 'No new keys found',
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to import GitHub keys',
				color: 'error'
			});
		} finally {
			importing = false;
		}
	}

	async function deleteIdentity(identity: SshIdentity) {
		if (deletingId) return;
		deletingId = identity.id;
		try {
			const res = await apiFetch(`/apiv1/ssh-identities/${identity.id}`, { method: 'DELETE' });
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(
					data?.message ||
						(res.status === 409
							? 'This identity is attached to a sandbox'
							: 'Failed to delete identity')
				);
			}
			invalidate();
			toasts.add({ title: 'Identity removed', color: 'success' });
		} catch (e) {
			toasts.add({
				title: res409Title(e),
				description: e instanceof Error ? e.message : 'Failed to delete identity',
				color: 'error'
			});
		} finally {
			deletingId = null;
		}
	}

	function res409Title(e: unknown): string {
		return e instanceof Error && e.message.toLowerCase().includes('attached')
			? 'Identity in use'
			: 'Error';
	}
</script>

<SettingsSection
	{index}
	title="SSH identities"
	description="Public keys used to log into your sandboxes"
>
	{#snippet icon(_hovered)}<Terminal class="h-[18px] w-[18px]" />{/snippet}
	{#snippet actions()}
		<Button size="sm" variant="secondary" loading={importing} onclick={importFromGithub}>
			<Github class="h-3.5 w-3.5" /> Import from GitHub
		</Button>
		<Button size="sm" variant="secondary" onclick={() => (showAdd = !showAdd)}>
			<Plus class="h-3.5 w-3.5" /> Add identity
		</Button>
	{/snippet}

	{#if showAdd}
		<div class="usi-add">
			<Field label="Name" for="usi-name">
				<Input id="usi-name" bind:value={newName} placeholder="laptop" maxlength={63} />
			</Field>
			<Field label="Public key" for="usi-key">
				<textarea
					id="usi-key"
					class="usi-key-input"
					bind:value={newKey}
					rows="3"
					placeholder="ssh-ed25519 AAAA..."
					spellcheck="false"></textarea>
			</Field>
			<div class="usi-add-actions">
				<Button size="sm" variant="ghost" onclick={() => (showAdd = false)}>Cancel</Button>
				<Button
					size="sm"
					variant="primary"
					disabled={!newName.trim() || !newKey.trim()}
					loading={adding}
					onclick={addIdentity}
				>
					Add identity
				</Button>
			</div>
		</div>
	{/if}

	{#if identitiesQuery.isPending}
		<Skeleton height="4rem" />
	{:else if identitiesQuery.isError}
		<p class="usi-empty">Could not load your SSH identities. Try again shortly.</p>
	{:else if identities.length === 0}
		<p class="usi-empty">
			No identities yet. Add a public key or import the ones on your GitHub profile.
		</p>
	{:else}
		<div class="usi-list">
			{#each identities as identity (identity.id)}
				<div class="usi-row">
					<div class="usi-row-text">
						<span class="usi-row-name">{identity.name}</span>
						<span class="usi-row-key">{keyLabel(identity.publicKey)}</span>
					</div>
					<span class="usi-row-when">added {timeAgo(identity.createdAt)}</span>
					<Button
						size="sm"
						variant="ghost"
						aria-label="Delete {identity.name}"
						loading={deletingId === identity.id}
						onclick={() => {
							deleteTarget = identity;
							deleteConfirmOpen = true;
						}}
					>
						<Trash2 class="h-3.5 w-3.5" />
					</Button>
				</div>
			{/each}
		</div>
	{/if}
</SettingsSection>

<ConfirmModal
	bind:open={deleteConfirmOpen}
	title="Remove SSH identity?"
	description={`${deleteTarget?.name ?? 'This identity'} will no longer grant access to new sandbox sessions. Sandboxes still using it will block the removal.`}
	confirmLabel="Remove"
	onconfirm={() => {
		if (deleteTarget) deleteIdentity(deleteTarget);
	}}
	oncancel={() => {
		deleteTarget = null;
	}}
/>

<style>
	.usi-add {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.875rem;
		margin-bottom: 1rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-sunken);
	}

	.usi-key-input {
		width: 100%;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-surface);
		color: var(--text-default);
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: 1.5;
		padding: 0.5rem 0.75rem;
		resize: vertical;
	}

	.usi-key-input:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: -1px;
	}

	.usi-add-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.usi-empty {
		font-size: var(--text-footnote);
		line-height: 1.5;
		color: var(--text-muted);
	}

	.usi-list {
		display: flex;
		flex-direction: column;
	}

	.usi-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.625rem 0.25rem;
	}

	.usi-row + .usi-row {
		box-shadow: inset 0 1px 0 var(--rule);
	}

	.usi-row-text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
		flex: 1;
	}

	.usi-row-name {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.usi-row-key {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.usi-row-when {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
		white-space: nowrap;
	}
</style>
