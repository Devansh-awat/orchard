<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { goto } from '$app/navigation';
	import { Check, ChevronLeft } from 'lucide-svelte';
	import { Button, Field, Input, Modal, Select } from '$lib/components/ui';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { sshIdentitiesQueryOptions } from '$lib/queries/sandboxes';
	import { queryClient } from '$lib/query';
	import { apiFetch, toasts } from '$lib/stores';
	import type {
		Sandbox,
		SandboxCreateInput,
		SandboxRunnerId,
		SandboxRunnerInfo
	} from '$lib/types/sandbox';
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
	const unavailable = $derived(app.runners.filter((r) => !r.available));
	const choosing = $derived(runners.length > 1);
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
	let step = $state(0);

	const runnerInfo = $derived(app.runners.find((r) => r.id === runner) ?? null);
	const steps = $derived(choosing ? ['runner', 'basics', 'setup'] : ['basics', 'setup']);
	const current = $derived(steps[Math.min(step, steps.length - 1)]);
	const last = $derived(step >= steps.length - 1);

	const TAGLINES: Record<string, string> = {
		kubernetes: "Lives on this Orchard's own cluster, next to your apps.",
		vercel: 'Boots in a Vercel Sandbox microVM.'
	};

	function perks(info: SandboxRunnerInfo): string[] {
		const caps = info.capabilities;
		return [
			caps.persistence === 'volume' ? 'Keeps its disk between runs' : 'Snapshotted when it stops',
			caps.pty === 'native' ? 'Native terminals' : 'No interactive terminal',
			caps.maxRunMs
				? `Sleeps after ${Math.round(caps.maxRunMs / 3_600_000)}h`
				: 'Runs as long as you need',
			...(caps.fork ? ['Can be forked'] : [])
		];
	}

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
			{#if current === 'runner'}
				<h2 class="title">Where should it run?</h2>
				<p class="lede">Each machine picks once. The next one can live somewhere else.</p>
				<div class="options" role="radiogroup" aria-label="Runs on">
					{#each runners as r (r.id)}
						{@const on = runner === r.id}
						<button
							type="button"
							class="option"
							class:option--on={on}
							role="radio"
							aria-checked={on}
							onclick={() => (runner = r.id)}
							ondblclick={() => {
								runner = r.id;
								step += 1;
							}}
						>
							<span class="option-head">
								<span class="option-tile"><RunnerTile runner={r.id} /></span>
								<span class="option-mark" aria-hidden="true">
									{#if on}<Check size={12} strokeWidth={2.5} />{/if}
								</span>
							</span>
							<span class="option-name">{r.label || runnerLabel(r.id)}</span>
							<span class="option-tag">{TAGLINES[r.id] ?? `Runs on ${r.label}.`}</span>
							<ul class="perks">
								{#each perks(r) as perk (perk)}
									<li><Check size={13} strokeWidth={2} /> {perk}</li>
								{/each}
							</ul>
						</button>
					{/each}
				</div>
				{#if unavailable.length > 0}
					<p class="note">
						{#each unavailable as r (r.id)}
							{r.label} is unavailable{r.reason ? `: ${r.reason}` : ''}.
						{/each}
					</p>
				{/if}
			{:else if current === 'basics'}
				<h2 class="title">What are you working on?</h2>
				<p class="lede">
					{runnerInfo ? `It runs on ${runnerInfo.label}. ` : ''}Both fields are optional, and you
					can add more repositories later.
				</p>
				<form
					class="fields"
					onsubmit={(e) => {
						e.preventDefault();
						next();
					}}
				>
					<Field label="Name" hint="One is generated when empty" for="gh-name">
						<Input id="gh-name" bind:value={name} placeholder="leaf-box" maxlength={63} />
					</Field>
					<Field label="Repository" hint="Cloned on first boot" for="gh-repo">
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
			{:else}
				<h2 class="title">Anything to set up first?</h2>
				<p class="lede">
					Runs once as you, the first time the machine boots. Leave it empty to skip.
				</p>
				<textarea
					id="gh-setup"
					class="script gh-mono"
					rows="5"
					aria-label="Setup script"
					bind:value={setup}
					placeholder={'pnpm install\npnpm db:migrate'}></textarea>
				<div class="summary">
					<span class="summary-tile"><RunnerTile {runner} size={20} /></span>
					<span class="summary-text">
						<span class="summary-name">{name.trim() || 'A generated name'}</span>
						<span class="summary-meta"
							>{runnerInfo?.label ?? runnerLabel(runner)}{repoUrl.trim()
								? ` · ${repoUrl.trim().replace(/^https?:\/\/(www\.)?github\.com\//, '')}`
								: ' · no repository yet'}</span
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
				disabled={last ? blocked : current === 'runner' ? !runner : false}
			>
				{last ? (creating ? 'Creating…' : 'Create machine') : 'Continue'}
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
		margin: 0.25rem 0 0;
		font-size: 1.375rem;
		line-height: 1.3;
		font-weight: 600;
		color: var(--text-default);
		letter-spacing: -0.01em;
	}

	.lede {
		margin: 0 0 0.75rem;
		font-size: var(--text-footnote);
		line-height: var(--gh-lh-ui);
		color: var(--text-muted);
	}

	.options {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: 0.75rem;
	}

	.option {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.25rem;
		padding: 1rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-raised);
		color: var(--text-default);
		text-align: left;
		transition:
			border-color var(--dur-fast) ease,
			background-color var(--dur-fast) ease,
			box-shadow var(--dur-fast) ease;
	}

	.option:hover {
		border-color: var(--border-strong);
	}

	.option:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.option--on,
	.option--on:hover {
		border-color: var(--accent);
		background: color-mix(in oklab, var(--accent) 6%, var(--bg-raised));
		box-shadow: 0 0 0 1px var(--accent);
	}

	.option-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		margin-bottom: 0.5rem;
	}

	.option-tile {
		display: inline-grid;
		transform: scale(1.33);
		transform-origin: left center;
	}

	.option-mark {
		display: inline-grid;
		place-items: center;
		width: 1.125rem;
		height: 1.125rem;
		border-radius: 999px;
		border: 1px solid var(--border-strong);
		color: var(--text-on-accent);
		transition:
			background-color var(--dur-fast) ease,
			border-color var(--dur-fast) ease;
	}

	.option--on .option-mark {
		border-color: var(--accent);
		background: var(--accent);
	}

	.option-name {
		font-weight: 600;
		font-size: var(--text-body);
	}

	.option-tag {
		font-size: var(--text-footnote);
		line-height: var(--gh-lh-ui);
		color: var(--text-muted);
	}

	.perks {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin: 0.75rem 0 0;
		padding: 0.75rem 0 0;
		border-top: 1px solid var(--border-default);
		list-style: none;
		width: 100%;
	}

	.perks li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-muted);
	}

	.perks :global(svg) {
		flex: none;
		color: var(--accent);
	}

	.fields {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.note {
		margin: 0.25rem 0 0;
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
