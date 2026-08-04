<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { apiFetch, toasts } from '$lib/stores';
	import { queryClient } from '$lib/query';
	import { Button, Field, Input, SectionCard, Select } from '$lib/components/ui';
	import { sshIdentitiesQueryOptions } from '$lib/queries/sandboxes';
	import type { Sandbox, SandboxPatchInput } from '$lib/types/sandbox';

	let { sandbox }: { sandbox: Sandbox } = $props();

	const identitiesQuery = createQuery(() => sshIdentitiesQueryOptions());
	const identities = $derived(identitiesQuery.data ?? []);

	let name = $state(sandbox.name);
	let identityId = $state(sandbox.sshIdentity?.id ?? '');
	let setupScript = $state(sandbox.setupScript ?? '');
	let saving = $state<string | null>(null);

	let lastName = sandbox.name;
	let lastIdentityId = sandbox.sshIdentity?.id ?? '';
	let lastSetupScript = sandbox.setupScript ?? '';
	$effect(() => {
		if (sandbox.name !== lastName) {
			lastName = sandbox.name;
			name = sandbox.name;
		}
		const serverIdentity = sandbox.sshIdentity?.id ?? '';
		if (serverIdentity !== lastIdentityId) {
			lastIdentityId = serverIdentity;
			identityId = serverIdentity;
		}
		const serverScript = sandbox.setupScript ?? '';
		if (serverScript !== lastSetupScript) {
			lastSetupScript = serverScript;
			setupScript = serverScript;
		}
	});

	const repoLabel = $derived(
		sandbox.repoUrl
			? sandbox.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '')
			: null
	);

	async function patch(body: SandboxPatchInput, action: string) {
		if (saving) return;
		saving = action;
		try {
			const res = await apiFetch(`/apiv1/sandboxes/${sandbox.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || 'Failed to update sandbox');
			}
			queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
			toasts.add({ title: 'Sandbox updated', color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update sandbox',
				color: 'error'
			});
		} finally {
			saving = null;
		}
	}

	function saveSetupScript() {
		patch({ setupScript: setupScript.trim() ? setupScript : null }, 'setup');
	}
</script>

<SectionCard title="Settings">
	<div class="sbs-body">
		<Field label="Name" for="sbs-name">
			<div class="sbs-row">
				<Input id="sbs-name" bind:value={name} maxlength={63} />
				<Button
					size="sm"
					variant="secondary"
					disabled={!name.trim() || name.trim() === sandbox.name}
					loading={saving === 'name'}
					onclick={() => patch({ name: name.trim() }, 'name')}
				>
					Save
				</Button>
			</div>
		</Field>
		<Field label="SSH identity" for="sbs-identity">
			<Select
				id="sbs-identity"
				bind:value={identityId}
				disabled={identities.length === 0}
				onchange={() => {
					if (identityId && identityId !== (sandbox.sshIdentity?.id ?? '')) {
						patch({ sshIdentityId: identityId }, 'identity');
					}
				}}
			>
				{#if !sandbox.sshIdentity}
					<option value="">None</option>
				{/if}
				{#each identities as identity (identity.id)}
					<option value={identity.id}>{identity.name}</option>
				{/each}
			</Select>
			<a class="sbs-link" href="/user/settings?tab=sandbox">Manage identities in user settings</a>
		</Field>
		<Field
			label="Setup script"
			hint="Runs once as the dev user on first boot (logged to ~/.setup.log)"
			for="sbs-setup"
		>
			<textarea
				id="sbs-setup"
				class="sbs-script"
				bind:value={setupScript}
				rows="4"
				placeholder="#!/bin/bash&#10;sudo apt-get install -y postgresql-client"
				spellcheck="false"
			></textarea>
			<div class="sbs-script-actions">
				<Button
					size="sm"
					variant="secondary"
					disabled={setupScript === (sandbox.setupScript ?? '')}
					loading={saving === 'setup'}
					onclick={saveSetupScript}
				>
					Save script
				</Button>
			</div>
		</Field>
		<div class="sbs-repo">
			{#if repoLabel}
				<span class="sbs-repo-value">{repoLabel}</span>
				<span class="sbs-repo-note">cloned on first boot</span>
			{:else}
				<span class="sbs-repo-note">No repository linked</span>
			{/if}
		</div>
	</div>
</SectionCard>

<style>
	.sbs-body {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.sbs-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.sbs-row :global(.input) {
		flex: 1;
		min-width: 0;
	}

	.sbs-link {
		display: inline-block;
		margin-top: 0.375rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-link);
		text-decoration: none;
	}

	.sbs-link:hover {
		text-decoration: underline;
	}

	.sbs-script {
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

	.sbs-script:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: -1px;
	}

	.sbs-script-actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 0.375rem;
	}

	.sbs-repo {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}

	.sbs-repo-value {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-default);
	}

	.sbs-repo-note {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}
</style>
