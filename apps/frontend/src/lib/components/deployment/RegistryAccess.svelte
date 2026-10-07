<script lang="ts">
	import { KeyRound } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { Button, Field, Input } from '$lib/components/ui';
	import { imageRegistryHost, registryHint, tokenLabel } from '$lib/utils/registry';

	let { projectId, image }: { projectId: string; image: string } = $props();

	type Credential = { id: string; registry: string; username: string };

	let credentials = $state<Credential[]>([]);
	let loaded = $state(false);
	let editing = $state(false);
	let saving = $state(false);
	let removing = $state(false);
	let username = $state('');
	let password = $state('');

	const host = $derived(imageRegistryHost(image));
	const match = $derived(credentials.find((c) => c.registry === host) ?? null);
	const canSave = $derived(!!host && !!username.trim() && !!password);

	async function load() {
		if (!projectId) return;
		const res = await apiFetch(`/apiv1/projects/${projectId}/registry-credentials`);
		if (res.ok) credentials = await res.json();
		loaded = true;
	}

	$effect(() => {
		if (projectId) void load();
	});

	function open() {
		username = match?.username ?? '';
		password = '';
		editing = true;
	}

	async function save() {
		if (!canSave) return;
		saving = true;
		try {
			const res = await apiFetch(`/apiv1/projects/${projectId}/registry-credentials`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ registry: host, username: username.trim(), password })
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to save credential');
			}
			toasts.add({
				title: `Pulling from ${host} as ${username.trim()}`,
				description: 'Pods are rolling to pick up the credential.',
				color: 'success'
			});
			editing = false;
			password = '';
			await load();
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : 'Failed to save credential',
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}

	async function remove() {
		if (!match) return;
		removing = true;
		try {
			const res = await apiFetch(`/apiv1/projects/${projectId}/registry-credentials/${match.id}`, {
				method: 'DELETE'
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to remove credential');
			}
			toasts.add({ title: `Removed ${host} credential`, color: 'success' });
			await load();
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : 'Failed to remove credential',
				color: 'error'
			});
		} finally {
			removing = false;
		}
	}
</script>

{#if loaded && host}
	<div class="ra">
		<div class="ra-head">
			<span class="ra-title"><KeyRound class="h-3.5 w-3.5" /> Registry access</span>
			{#if !editing}
				<div class="ra-actions">
					{#if match}
						<Button variant="ghost" size="sm" loading={removing} onclick={remove}>Remove</Button>
						<Button variant="secondary" size="sm" onclick={open}>Replace</Button>
					{:else}
						<Button variant="secondary" size="sm" onclick={open}>Add credential</Button>
					{/if}
				</div>
			{/if}
		</div>
		{#if match}
			<p class="ra-help">
				Pulls from <code>{host}</code> as <code>{match.username}</code>. Shared by every app and job
				in this project that uses <code>{host}</code>.
			</p>
		{:else}
			<p class="ra-help">
				Pulls from <code>{host}</code> anonymously. If the image is private, add a credential and the
				pods will roll to use it.
			</p>
		{/if}
		{#if editing}
			<form
				class="ra-form"
				onsubmit={(e) => {
					e.preventDefault();
					save();
				}}
			>
				<div class="ra-grid">
					<Field label="Username" for="ra-username">
						<Input id="ra-username" bind:value={username} autocomplete="off" spellcheck="false" />
					</Field>
					<Field label={tokenLabel(host)} for="ra-password">
						<Input
							id="ra-password"
							type="password"
							bind:value={password}
							autocomplete="new-password"
						/>
					</Field>
				</div>
				<p class="ra-help">{registryHint(host)}</p>
				<div class="ra-actions">
					<Button variant="ghost" size="sm" onclick={() => (editing = false)}>Cancel</Button>
					<Button type="submit" variant="primary" size="sm" loading={saving} disabled={!canSave}>
						{match ? 'Replace credential' : 'Save credential'}
					</Button>
				</div>
			</form>
		{/if}
	</div>
{/if}

<style>
	.ra {
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border-subtle);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.ra-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.ra-title {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-fg);
	}
	.ra-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.ra-help {
		margin: 0;
		font-size: var(--text-micro);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.ra-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.ra-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
	}
	@media (max-width: 640px) {
		.ra-grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
