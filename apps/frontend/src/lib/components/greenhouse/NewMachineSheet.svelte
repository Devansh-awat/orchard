<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { goto } from '$app/navigation';
	import { Button, Field, Input, Modal, Select } from '$lib/components/ui';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import { sshIdentitiesQueryOptions } from '$lib/queries/sandboxes';
	import { queryClient } from '$lib/query';
	import { apiFetch, toasts } from '$lib/stores';
	import type { Sandbox, SandboxCreateInput, SandboxRunnerId } from '$lib/types/sandbox';
	import { getGreenhouseApp } from './app.svelte';
	import { runnerLabel } from './format';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const app = getGreenhouseApp();
	const identitiesQuery = createQuery(() => ({
		...sshIdentitiesQueryOptions(),
		enabled: open && !app.env.harness
	}));
	const identities = $derived(identitiesQuery.data ?? []);
	const noIdentities = $derived(identitiesQuery.isSuccess && identities.length === 0);

	const runners = $derived(app.runners.filter((r) => r.available));
	const runnerOptions = $derived(
		runners.map((r) => ({
			value: r.id,
			label: r.label || runnerLabel(r.id)
		}))
	);
	const atLimit = $derived(
		app.list?.maxSandboxes != null && app.machines.length >= app.list.maxSandboxes
	);

	let name = $state('');
	let runner = $state<string>('');
	let repoUrl = $state('');
	let identity = $state('');
	let setup = $state('');
	let creating = $state(false);
	let error = $state<string | null>(null);

	const runnerInfo = $derived(app.runners.find((r) => r.id === runner) ?? null);
	const runnerHint = $derived.by(() => {
		const caps = runnerInfo?.capabilities;
		if (!caps) return undefined;
		const parts = [
			caps.persistence === 'volume' ? 'Persistent disk' : 'Snapshot on stop',
			caps.pty === 'native' ? 'native terminals' : 'no interactive terminal',
			caps.maxRunMs ? `stops after ${Math.round(caps.maxRunMs / 3_600_000)}h` : null
		].filter(Boolean);
		return parts.join(', ');
	});

	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			name = '';
			repoUrl = '';
			setup = '';
			error = null;
			runner =
				app.defaultRunner && runners.some((r) => r.id === app.defaultRunner)
					? app.defaultRunner
					: (runners[0]?.id ?? '');
		}
		wasOpen = open;
	});

	$effect(() => {
		if (identities.length === 1 && !identity) identity = identities[0].id;
	});

	async function create() {
		if (creating) return;
		creating = true;
		error = null;
		const input: SandboxCreateInput = {};
		if (app.organizationId) input.organizationId = app.organizationId;
		if (runner) input.runner = runner as SandboxRunnerId;
		if (name.trim()) input.name = name.trim();
		if (repoUrl.trim()) input.repoUrl = repoUrl.trim();
		if (identity) input.sshIdentityId = identity;
		if (setup.trim()) input.setupScript = setup;
		try {
			const res = await apiFetch('/apiv1/sandboxes', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(input)
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.message ?? 'Could not create the machine');
			const sandbox = (body?.sandbox ?? body) as Sandbox;
			await queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
			open = false;
			toasts.add({ title: `Creating ${sandbox.name}`, color: 'success' });
			app.openMachine(sandbox.id);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not create the machine';
		} finally {
			creating = false;
		}
	}
</script>

<Modal bind:open title="New machine" size="md">
	<div class="form">
		{#if runnerOptions.length > 1}
			<Field label="Runs on" hint={runnerHint}>
				<SegmentedControl options={runnerOptions} bind:value={runner} label="Runner" grow />
			</Field>
		{:else if runnerInfo}
			<p class="runner-note">Runs on {runnerInfo.label}. {runnerHint}</p>
		{/if}
		{#if app.runners.some((r) => !r.available)}
			<p class="runner-note">
				{#each app.runners.filter((r) => !r.available) as r (r.id)}
					{r.label} is unavailable{r.reason ? `: ${r.reason}` : ''}.
				{/each}
			</p>
		{/if}
		<Field label="Name" hint="Optional, one is generated when empty" for="gh-name">
			<Input id="gh-name" bind:value={name} placeholder="leaf-box" maxlength={63} />
		</Field>
		<Field label="Repository" hint="Optional, cloned on first boot. Add more later." for="gh-repo">
			<Input
				id="gh-repo"
				bind:value={repoUrl}
				placeholder="https://github.com/you/repo"
				autocomplete="off"
			/>
		</Field>
		{#if noIdentities}
			<div class="need">
				<span>Machines need an SSH key so editors can connect.</span>
				<Button size="sm" variant="secondary" onclick={() => goto('/user/settings?tab=sandbox')}
					>Add a key</Button
				>
			</div>
		{:else if identities.length > 1}
			<Field label="SSH key" for="gh-identity">
				<Select id="gh-identity" bind:value={identity}>
					<option value="" disabled>Pick a key</option>
					{#each identities as id (id.id)}
						<option value={id.id}>{id.name}</option>
					{/each}
				</Select>
			</Field>
		{/if}
		<Field label="Setup script" hint="Runs once, on the machine's first boot" for="gh-setup">
			<textarea
				id="gh-setup"
				class="script gh-mono"
				rows="3"
				bind:value={setup}
				placeholder="pnpm install"></textarea>
		</Field>
		{#if error}<p class="error">{error}</p>{/if}
		{#if atLimit}<p class="error">You have reached the machine limit for this organization.</p>{/if}
	</div>
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (open = false)}>Cancel</Button>
		<Button
			variant="primary"
			onclick={create}
			disabled={creating ||
				noIdentities ||
				atLimit ||
				(identities.length > 1 && !identity) ||
				!runner}
		>
			{creating ? 'Creating…' : 'Create machine'}
		</Button>
	{/snippet}
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.runner-note {
		margin: 0;
		font-size: var(--text-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-muted);
	}

	.need {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		border-radius: var(--gh-r-row);
		border: 1px solid var(--border-default);
		background: color-mix(in oklab, var(--status-warning) 8%, transparent);
		font-size: var(--text-footnote);
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

	.error {
		margin: 0;
		font-size: var(--text-footnote);
		line-height: var(--gh-lh-ui);
		color: var(--status-error);
	}
</style>
