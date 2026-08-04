<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { goto } from '$app/navigation';
	import { Github, Loader2 } from 'lucide-svelte';
	import { apiFetch } from '$lib/stores';
	import { Button, Field, Input, Modal, Select } from '$lib/components/ui';
	import { sshIdentitiesQueryOptions } from '$lib/queries/sandboxes';
	import type { SandboxCreateInput } from '$lib/types/sandbox';

	interface Repository {
		id: number;
		full_name: string;
		private: boolean;
	}

	let {
		open = $bindable(false),
		creating = false,
		oncreate
	}: {
		open?: boolean;
		creating?: boolean;
		oncreate: (input: SandboxCreateInput) => void;
	} = $props();

	const identitiesQuery = createQuery(() => ({
		...sshIdentitiesQueryOptions(),
		enabled: open
	}));
	const identities = $derived(identitiesQuery.data ?? []);
	const noIdentities = $derived(identitiesQuery.isSuccess && identities.length === 0);

	let name = $state('');
	let repoUrl = $state('');
	let sshIdentityId = $state('');
	let setupScript = $state('');

	let repositories = $state<Repository[]>([]);
	let loadingRepos = $state(false);
	let reposError = $state<string | null>(null);
	let reposFetched = false;
	let pickerOpen = $state(false);

	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			name = '';
			repoUrl = '';
			sshIdentityId = '';
			setupScript = '';
			pickerOpen = false;
		}
		wasOpen = open;
	});

	let autoPicked = false;
	$effect(() => {
		if (!open) {
			autoPicked = false;
			return;
		}
		if (!autoPicked && identities.length === 1) {
			autoPicked = true;
			sshIdentityId = identities[0].id;
		}
	});

	async function fetchRepositories() {
		if (reposFetched || loadingRepos) return;
		loadingRepos = true;
		reposError = null;
		try {
			const res = await apiFetch('/apiv1/github/repositories');
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				reposError = body?.message || 'Could not load your repositories.';
				return;
			}
			const data = await res.json();
			repositories = Array.isArray(data) ? data : (data.repositories ?? []);
			reposFetched = true;
		} catch {
			reposError = 'Could not load your repositories.';
		} finally {
			loadingRepos = false;
		}
	}

	const repoFilter = $derived(repoUrl.trim().toLowerCase());
	const filteredRepos = $derived(
		repositories
			.filter((r) => !repoFilter || r.full_name.toLowerCase().includes(repoFilter))
			.slice(0, 8)
	);

	function pickRepo(repo: Repository) {
		repoUrl = `https://github.com/${repo.full_name}`;
		pickerOpen = false;
	}

	function onRepoFocus() {
		pickerOpen = true;
		fetchRepositories();
	}

	const canCreate = $derived(!creating && !noIdentities);

	function openIdentitySettings() {
		open = false;
		goto('/user/settings?tab=sandbox');
	}

	function submit() {
		const input: SandboxCreateInput = {};
		if (name.trim()) input.name = name.trim();
		if (repoUrl.trim()) input.repoUrl = repoUrl.trim();
		if (sshIdentityId) input.sshIdentityId = sshIdentityId;
		if (setupScript.trim()) input.setupScript = setupScript;
		oncreate(input);
	}
</script>

<Modal bind:open title="New sandbox" size="md">
	<div class="scm-form">
		<Field label="Name" hint="Optional, one is generated when empty" for="sbx-name">
			<Input id="sbx-name" bind:value={name} placeholder="my-sandbox" maxlength={63} />
		</Field>
		<Field
			label="Repository"
			hint="Optional, cloned into the sandbox on first boot"
			for="sbx-repo"
		>
			<div class="scm-repo">
				<Input
					id="sbx-repo"
					bind:value={repoUrl}
					placeholder="https://github.com/you/repo or search your repos"
					onfocus={onRepoFocus}
					autocomplete="off"
				/>
				{#if pickerOpen}
					{#if loadingRepos}
						<div class="scm-repo-hint">
							<Loader2 class="h-3.5 w-3.5 animate-spin" /> Loading your repositories
						</div>
					{:else if reposError}
						<div class="scm-repo-hint">{reposError} You can paste a URL instead.</div>
					{:else if filteredRepos.length > 0}
						<div class="scm-repo-list" role="listbox" aria-label="Your repositories">
							{#each filteredRepos as repo (repo.id)}
								<button
									type="button"
									class="scm-repo-item"
									role="option"
									aria-selected={repoUrl === `https://github.com/${repo.full_name}`}
									onclick={() => pickRepo(repo)}
								>
									<Github size={13} />
									<span class="scm-repo-name">{repo.full_name}</span>
									{#if repo.private}<span class="scm-repo-private">private</span>{/if}
								</button>
							{/each}
						</div>
					{/if}
				{/if}
			</div>
		</Field>
		<Field label="SSH identity" hint="The key used to log into the sandbox" for="sbx-identity">
			{#if noIdentities}
				<div class="scm-no-identities">
					<span>You have no SSH identities yet. Add one in user settings first.</span>
					<Button size="sm" variant="secondary" onclick={openIdentitySettings}>
						Set up SSH identities
					</Button>
				</div>
			{:else}
				<Select id="sbx-identity" bind:value={sshIdentityId}>
					{#if identities.length !== 1}
						<option value="">Pick an identity</option>
					{/if}
					{#each identities as identity (identity.id)}
						<option value={identity.id}>{identity.name}</option>
					{/each}
				</Select>
			{/if}
		</Field>
		<Field
			label="Setup script"
			hint="Optional, runs once as the dev user on first boot (logged to ~/.setup.log)"
			for="sbx-setup"
		>
			<textarea
				id="sbx-setup"
				class="scm-script"
				bind:value={setupScript}
				rows="4"
				placeholder="#!/bin/bash&#10;sudo apt-get install -y postgresql-client"
				spellcheck="false"
			></textarea>
		</Field>
	</div>
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (open = false)}>Cancel</Button>
		<Button variant="primary" loading={creating} disabled={!canCreate} onclick={submit}>
			Create sandbox
		</Button>
	{/snippet}
</Modal>

<style>
	.scm-form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.scm-repo {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.scm-repo-hint {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}

	.scm-repo-list {
		display: flex;
		flex-direction: column;
		max-height: 12rem;
		overflow-y: auto;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		background: var(--bg-surface);
	}

	.scm-repo-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		border: none;
		background: none;
		color: var(--text-default);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		cursor: pointer;
		text-align: left;
		transition: background-color var(--dur-fast) ease;
	}

	.scm-repo-item:hover {
		background-color: var(--bg-hover);
	}

	.scm-repo-name {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.scm-repo-private {
		margin-left: auto;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		color: var(--text-faint);
	}

	.scm-no-identities {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
		padding: 0.625rem 0.875rem;
		border: 1px solid var(--status-info-border);
		border-radius: var(--radius-sm);
		background: var(--status-info-bg);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-default);
	}

	.scm-script {
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

	.scm-script:focus-visible {
		outline: 2px solid var(--focus-ring-color);
		outline-offset: -1px;
	}
</style>
