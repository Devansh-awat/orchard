<script lang="ts">
	import { onMount } from 'svelte';
	import { KeyRound, Trash2 } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { Button, Field, Input, SectionCard, Select, Skeleton } from '$lib/components/ui';
	import { REGISTRY_PRESETS, registryHint, tokenLabel } from '$lib/utils/registry';

	let { projectId, canEdit = false }: { projectId: string; canEdit?: boolean } = $props();

	type Credential = {
		id: string;
		registry: string;
		username: string;
		updatedAt: string;
	};

	let credentials = $state<Credential[]>([]);
	let loading = $state(true);
	let saving = $state(false);
	let removing = $state<string | null>(null);

	let preset = $state('ghcr.io');
	let customHost = $state('');
	let username = $state('');
	let password = $state('');

	const registry = $derived(preset === 'custom' ? customHost.trim() : preset);
	const canSave = $derived(!!registry && !!username.trim() && !!password);

	async function load() {
		loading = true;
		try {
			const res = await apiFetch(`/apiv1/projects/${projectId}/registry-credentials`);
			if (res.ok) credentials = await res.json();
		} finally {
			loading = false;
		}
	}

	async function save() {
		if (!canSave) return;
		saving = true;
		try {
			const res = await apiFetch(`/apiv1/projects/${projectId}/registry-credentials`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ registry, username: username.trim(), password })
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to save credential');
			}
			const saved: Credential = await res.json();
			toasts.add({
				title: 'Registry credential saved',
				description: `Apps pulling from ${saved.registry} now authenticate as ${saved.username}`,
				color: 'success'
			});
			username = '';
			password = '';
			customHost = '';
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

	async function remove(cred: Credential) {
		removing = cred.id;
		try {
			const res = await apiFetch(`/apiv1/projects/${projectId}/registry-credentials/${cred.id}`, {
				method: 'DELETE'
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to remove credential');
			}
			toasts.add({ title: `Removed ${cred.registry} credential`, color: 'success' });
			await load();
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : 'Failed to remove credential',
				color: 'error'
			});
		} finally {
			removing = null;
		}
	}

	onMount(load);
</script>

<SectionCard
	title="Registry credentials"
	description="Pull private images from GitHub Packages, Docker Hub, or any other registry. A credential is attached to every app and job in this project whose image lives on that registry."
>
	{#if loading}
		<Skeleton class="h-10 w-full" />
	{:else if credentials.length > 0}
		<ul class="rc-list">
			{#each credentials as cred (cred.id)}
				<li class="rc-row">
					<span class="rc-icon"><KeyRound size={14} /></span>
					<span class="rc-main">
						<span class="rc-registry">{cred.registry}</span>
						<span class="rc-user">{cred.username}</span>
					</span>
					{#if canEdit}
						<Button
							variant="ghost"
							size="sm"
							loading={removing === cred.id}
							onclick={() => remove(cred)}
							aria-label={`Remove ${cred.registry} credential`}
						>
							<Trash2 class="h-3.5 w-3.5" />
						</Button>
					{/if}
				</li>
			{/each}
		</ul>
	{:else if !canEdit}
		<p class="rc-empty">No private registries configured. Images are pulled anonymously.</p>
	{/if}

	{#if canEdit}
		<form
			class="rc-form"
			onsubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			<div class="rc-grid">
				<Field label="Registry" for="rc-preset">
					<Select id="rc-preset" bind:value={preset}>
						{#each REGISTRY_PRESETS as p (p.value)}
							<option value={p.value}>{p.label}</option>
						{/each}
					</Select>
				</Field>
				{#if preset === 'custom'}
					<Field label="Host" for="rc-host">
						<Input
							id="rc-host"
							bind:value={customHost}
							placeholder="registry.example.com"
							autocomplete="off"
							spellcheck="false"
						/>
					</Field>
				{/if}
				<Field label="Username" for="rc-username">
					<Input id="rc-username" bind:value={username} autocomplete="off" spellcheck="false" />
				</Field>
				<Field label={tokenLabel(preset)} for="rc-password">
					<Input
						id="rc-password"
						type="password"
						bind:value={password}
						autocomplete="new-password"
					/>
				</Field>
			</div>
			<p class="rc-hint">{registryHint(preset)}</p>
			<div class="rc-actions">
				<Button type="submit" variant="primary" size="sm" loading={saving} disabled={!canSave}>
					{credentials.some((c) => c.registry === registry)
						? 'Replace credential'
						: 'Add credential'}
				</Button>
			</div>
		</form>
	{/if}
</SectionCard>

<style>
	.rc-list {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.rc-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) 0;
	}

	.rc-row + .rc-row {
		box-shadow: inset 0 1px 0 var(--rule);
	}

	.rc-icon {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-muted);
	}

	.rc-main {
		display: flex;
		flex: 1;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.rc-registry {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		letter-spacing: var(--track-headline);
		color: var(--text-default);
	}

	.rc-user {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.rc-empty,
	.rc-hint {
		margin: 0;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.rc-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		margin-top: var(--space-4);
		padding-top: var(--space-4);
		box-shadow: inset 0 1px 0 var(--rule);
	}

	.rc-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
	}

	.rc-actions {
		display: flex;
		justify-content: flex-end;
	}

	@media (max-width: 640px) {
		.rc-grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
