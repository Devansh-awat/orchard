<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { goto } from '../../host/navigation';
	import { ChevronLeft } from 'lucide-svelte';
	import GitHubRepoPicker from '../deployment/GitHubRepoPicker.svelte';
	import { Button, Field, Input, Modal, Select } from '@orchard/graft-ui';
	import SegmentedControl from '@orchard/graft-ui/components/ui/SegmentedControl.svelte';
	import { motionStagger } from '@orchard/graft-ui/utils/motion.svelte';
	import { sshIdentitiesQueryOptions } from '../../lib/queries/sandboxes';
	import { queryClient } from '../../host/query';
	import { apiFetch, toasts } from '../../host/stores';
	import type { Sandbox, SandboxCreateInput, SandboxRunnerId } from '../../lib/types/sandbox';
	import { getGreenhouseApp } from './app.svelte';
	import { runnerLabel } from './format';
	import RunnerTile from './RunnerTile.svelte';

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
		runners.map((r) => ({ value: r.id, label: r.label || runnerLabel(r.id) }))
	);
	const atLimit = $derived(
		app.list?.maxSandboxes != null && app.machines.length >= app.list.maxSandboxes
	);

	let name = $state('');
	let runner = $state<string>('');
	let repoUrl = $state('');
	let repoName = $state<string | null>(null);
	let identity = $state('');
	let setup = $state('');
	let creating = $state(false);
	let error = $state<string | null>(null);
	let step = $state(0);

	const runnerInfo = $derived(app.runners.find((r) => r.id === runner) ?? null);
	const steps = ['machine', 'repo', 'setup'];
	const current = $derived(steps[Math.min(step, steps.length - 1)]);
	const last = $derived(step >= steps.length - 1);

	const blocked = $derived(
		creating || noIdentities || atLimit || (identities.length > 1 && !identity) || !runner
	);

	function next() {
		if (last) void create();
		else step += 1;
	}

	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			name = '';
			repoUrl = '';
			repoName = null;
			setup = '';
			error = null;
			step = 0;
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

<Modal bind:open size="lg">
	{#snippet header()}
		<div class="progress">
			<span class="step">Step {step + 1} of {steps.length}</span>
			<span class="bars" aria-hidden="true">
				{#each steps as name, i (name)}
					<span class="bar" class:bar--on={i <= step}></span>
				{/each}
			</span>
		</div>
	{/snippet}
	{#key current}
		<div class="pane" {@attach motionStagger()}>
			{#if current === 'machine'}
				<h2 class="title">New machine</h2>
				<form
					class="fields"
					onsubmit={(e) => {
						e.preventDefault();
						next();
					}}
				>
					{#if runnerOptions.length > 1}
						<Field label="Runs on">
							<SegmentedControl options={runnerOptions} bind:value={runner} label="Runs on" grow />
						</Field>
					{/if}
					<Field label="Name" for="gh-name">
						<Input id="gh-name" bind:value={name} placeholder="Generated if empty" maxlength={63} />
					</Field>
					{#if noIdentities}
						<div class="need">
							<span>Machines need an SSH key so editors can connect.</span>
							<Button
								size="sm"
								variant="secondary"
								onclick={() => goto('/user/settings?tab=sandbox')}>Add a key</Button
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
					<button type="submit" hidden aria-hidden="true" tabindex="-1"></button>
				</form>
			{:else if current === 'repo'}
				<h2 class="title">Repository</h2>
				<GitHubRepoPicker
					autofocus
					bind:selected={repoName}
					onpick={(repo) => (repoUrl = repo.url)}
					onclear={() => (repoUrl = '')}
				/>
			{:else}
				<h2 class="title">Setup script</h2>
				<p class="lede">Runs once, on first boot.</p>
				<textarea
					id="gh-setup"
					class="script gh-mono"
					rows="5"
					aria-label="Setup script"
					bind:value={setup}
					placeholder={'pnpm install'}></textarea>
				<div class="summary">
					<span class="summary-tile"><RunnerTile {runner} size={20} /></span>
					<span class="summary-text">
						<span class="summary-name">{name.trim() || 'A generated name'}</span>
						<span class="summary-meta"
							>{runnerInfo?.label ?? runnerLabel(runner)}{repoUrl.trim()
								? ` · ${repoUrl.trim().replace(/^https?:\/\/(www\.)?github\.com\//, '')}`
								: ' · no repository'}</span
						>
					</span>
				</div>
			{/if}
			{#if error}<p class="error">{error}</p>{/if}
			{#if atLimit}<p class="error">
					You have reached the machine limit for this organization.
				</p>{/if}
		</div>
	{/key}
	{#snippet footer()}
		<div class="foot">
			{#if step > 0}
				<Button variant="ghost" onclick={() => (step -= 1)} disabled={creating}>
					<ChevronLeft size={16} strokeWidth={1.75} /> Back
				</Button>
			{:else}
				<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
			{/if}
			<Button
				variant="primary"
				onclick={next}
				disabled={last ? blocked : current === 'machine' ? !runner : false}
			>
				{last
					? creating
						? 'Creating…'
						: 'Create machine'
					: current === 'repo' && !repoUrl
						? 'Skip'
						: 'Continue'}
			</Button>
		</div>
	{/snippet}
</Modal>

<style>
	.progress {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
	}

	.step {
		font-size: var(--text-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.bars {
		display: flex;
		gap: 0.25rem;
		width: 7.5rem;
	}

	.bar {
		flex: 1;
		height: 0.25rem;
		border-radius: 999px;
		background: var(--border-default);
		transition: background-color var(--dur-fast) ease;
	}

	.bar--on {
		background: var(--accent);
	}

	.pane {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}

	.title {
		margin: 0.25rem 0 0.75rem;
		font-size: 1.375rem;
		line-height: 1.3;
		font-weight: 600;
		color: var(--text-default);
		letter-spacing: -0.01em;
	}

	.lede {
		margin: -0.5rem 0 0.75rem;
		font-size: var(--text-footnote);
		line-height: var(--gh-lh-ui);
		color: var(--text-muted);
	}

	.fields {
		display: flex;
		flex-direction: column;
		gap: 1rem;
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
		padding: 0.75rem;
		border-radius: var(--gh-r-control);
		border: 1px solid var(--border-default);
		background: var(--bg-app);
		color: var(--text-default);
		font-size: var(--text-caption);
		line-height: 1.25rem;
		resize: vertical;
		outline: none;
	}

	.script:focus {
		border-color: var(--focus-ring-color);
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.summary {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-top: 0.75rem;
		padding: 0.75rem 1rem;
		border: 1px solid var(--border-default);
		border-radius: var(--gh-r-row);
		background: var(--bg-raised);
	}

	.summary-tile {
		display: inline-grid;
	}

	.summary-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.summary-name {
		font-weight: 600;
		font-size: var(--text-footnote);
		color: var(--text-default);
	}

	.summary-meta {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--text-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-muted);
	}

	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
	}

	.error {
		margin: 0.5rem 0 0;
		font-size: var(--text-footnote);
		line-height: var(--gh-lh-ui);
		color: var(--status-error);
	}
</style>
