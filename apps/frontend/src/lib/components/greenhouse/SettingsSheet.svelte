<script lang="ts">
	import { untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { Check, ChevronRight } from 'lucide-svelte';
	import { Button, Input } from '$lib/components/ui';
	import { queryClient } from '$lib/query';
	import { apiFetch, organizations, toasts } from '$lib/stores';
	import * as api from './api';
	import { getGreenhouseApp } from './app.svelte';
	import { ago, runnerLabel } from './format';
	import FormError from './FormError.svelte';
	import ProjectLinks, { ProjectLinkStore } from './ProjectLinks.svelte';
	import StepSheet from './StepSheet.svelte';
	import { StepStack } from './steps.svelte';

	type Step = 'overview' | 'setup' | 'projects' | 'attach' | 'delete';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const app = getGreenhouseApp();
	const machine = $derived(app.machine);
	const ws = $derived(app.ws);
	const owner = $derived(ws?.isOwner ?? false);

	const steps = new StepStack<Step>('overview');
	const projects = new ProjectLinkStore();

	let name = $state('');
	let nameSaved = $state(false);
	let savingName = false;
	let savedTimer: ReturnType<typeof setTimeout> | null = null;
	let setup = $state('');
	let savedSetup = $state('');
	let savingSetup = $state(false);
	let confirmName = $state('');
	let deleting = $state(false);

	let wasOpen = false;
	$effect(() => {
		const isOpen = open;
		if (isOpen && !wasOpen) untrack(startOver);
		wasOpen = isOpen;
	});

	function startOver() {
		if (!machine) return;
		name = machine.name;
		nameSaved = false;
		savedSetup = machine.setupScript ?? '';
		setup = savedSetup;
		confirmName = '';
		projects.resetPick();
		if (!ws) return;
		void projects.load(ws.sandboxId);
		const org = machine.organizationId ?? app.organizationId ?? null;
		if (!owner || !org) return;
		void projects.loadProjects(org, {
			userId: app.self?.id ?? null,
			orgRole: get(organizations).find((o) => o.id === org)?.myRole ?? null,
			superAdmin: app.superAdmin
		});
	}

	const facts = $derived(
		machine
			? [
					runnerLabel(machine.runner),
					machine.diskObserved ? `${machine.diskObserved} disk` : null,
					`created ${ago(machine.createdAt)}`,
					machine.lastActiveAt ? `active ${ago(machine.lastActiveAt)}` : null
				]
					.filter(Boolean)
					.join(' · ')
			: ''
	);

	const setupPreview = $derived(
		savedSetup
			.split('\n')
			.map((l) => l.trim())
			.find(Boolean) ?? ''
	);

	const title = $derived(
		{
			overview: 'Machine settings',
			setup: 'Setup script',
			projects: 'Projects',
			attach: 'Attach project',
			delete: `Delete ${machine?.name ?? 'machine'}?`
		}[steps.current]
	);

	async function patch(body: Record<string, unknown>) {
		if (!machine) throw new Error('No machine');
		const res = await apiFetch(`/apiv1/sandboxes/${machine.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Save failed');
		await queryClient.invalidateQueries({ queryKey: ['sandboxes'] });
	}

	async function saveName() {
		if (!machine || !owner || savingName) return;
		const next = name.trim();
		if (!next || next === machine.name) {
			name = machine.name;
			return;
		}
		savingName = true;
		try {
			await patch({ name: next });
			nameSaved = true;
			if (savedTimer) clearTimeout(savedTimer);
			savedTimer = setTimeout(() => (nameSaved = false), 1600);
		} catch (e) {
			name = machine.name;
			toasts.add({
				title: 'Could not rename',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			savingName = false;
		}
	}

	function onNameKey(e: KeyboardEvent) {
		const input = e.currentTarget as HTMLInputElement;
		if (e.key === 'Enter') {
			e.preventDefault();
			input.blur();
		} else if (e.key === 'Escape' && machine && name !== machine.name) {
			e.preventDefault();
			name = machine.name;
		}
	}

	function openSetup() {
		setup = savedSetup;
		steps.push('setup');
	}

	async function saveSetup() {
		if (!machine || !owner || savingSetup) return;
		if (setup === savedSetup) {
			steps.back();
			return;
		}
		savingSetup = true;
		try {
			await patch({ setupScript: setup.trim() ? setup : null });
			savedSetup = setup.trim() ? setup : '';
			steps.back();
		} catch (e) {
			toasts.add({
				title: 'Could not save the setup script',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			savingSetup = false;
		}
	}

	async function attach() {
		if (!ws) return;
		const link = await projects.attach(ws.sandboxId);
		if (!link) return;
		toasts.add({
			title: `Attached ${link.project.name}`,
			description: link.envFile,
			color: 'success'
		});
		steps.back();
	}

	function openDelete() {
		confirmName = '';
		steps.push('delete');
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

	function onenter() {
		const step = steps.current;
		if (step === 'overview') open = false;
		else if (step === 'setup') {
			if (owner) void saveSetup();
		} else if (step === 'projects') {
			if (owner && projects.available.length > 0) steps.push('attach');
		} else if (step === 'attach') void attach();
		else if (step === 'delete') void remove();
	}
</script>

<StepSheet
	bind:open
	{steps}
	{title}
	caption={steps.current === 'overview' ? facts : undefined}
	{onenter}
>
	{#if !machine}
		<p class="gh-sheet-note">No machine selected</p>
	{:else if steps.current === 'overview'}
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
		<div class="gh-group">
			<label class="gh-group-row">
				<span class="gh-group-label">Name</span>
				<span class="name-field">
					<Input
						bind:value={name}
						maxlength={63}
						disabled={!owner}
						aria-label="Name"
						autocomplete="off"
						spellcheck="false"
						onblur={saveName}
						onkeydown={onNameKey}
					/>
				</span>
				<span class="saved" aria-live="polite">
					{#if nameSaved}<Check size={14} strokeWidth={1.75} aria-label="Saved" />{/if}
				</span>
			</label>
			<button type="button" class="gh-group-row" onclick={openSetup}>
				<span class="gh-group-label">Setup script</span>
				<span class="gh-group-value" class:gh-mono={!!setupPreview}>{setupPreview || 'None'}</span>
				<span class="gh-group-chev"><ChevronRight size={16} strokeWidth={1.75} /></span>
			</button>
			<button type="button" class="gh-group-row" onclick={() => steps.push('projects')}>
				<span class="gh-group-label">Projects</span>
				<span class="gh-group-value">{projects.summary}</span>
				<span class="gh-group-chev"><ChevronRight size={16} strokeWidth={1.75} /></span>
			</button>
		</div>
		{#if owner}
			<button type="button" class="gh-sheet-danger" onclick={openDelete}>Delete machine…</button>
		{/if}
	{:else if steps.current === 'setup'}
		<textarea
			class="script gh-mono"
			rows="10"
			bind:value={setup}
			disabled={!owner}
			placeholder="Runs once, on first boot"
			aria-label="Setup script"
			spellcheck="false"
			data-autofocus></textarea>
	{:else if steps.current === 'projects'}
		<ProjectLinks store={projects} mode="list" />
	{:else if steps.current === 'attach'}
		<ProjectLinks store={projects} mode="attach" />
	{:else if steps.current === 'delete'}
		<Input
			bind:value={confirmName}
			placeholder="Type {machine.name} to confirm"
			aria-label="Type {machine.name} to confirm"
			autocomplete="off"
			spellcheck="false"
			data-autofocus
		/>
		<p class="gh-sheet-note">This removes its disk and unpushed work.</p>
	{/if}

	{#snippet footer()}
		{#if steps.current === 'overview'}
			<Button variant="primary" onclick={() => (open = false)}>Done</Button>
		{:else if steps.current === 'setup'}
			{#if owner}
				<Button variant="primary" disabled={savingSetup} onclick={saveSetup}>
					{savingSetup ? 'Saving…' : 'Save'}
				</Button>
			{:else}
				<Button variant="secondary" onclick={() => steps.back()}>Done</Button>
			{/if}
		{:else if steps.current === 'projects'}
			{#if owner}
				<Button
					variant="primary"
					disabled={projects.available.length === 0}
					onclick={() => steps.push('attach')}
				>
					Attach project
				</Button>
			{:else}
				<Button variant="secondary" onclick={() => steps.back()}>Done</Button>
			{/if}
		{:else if steps.current === 'attach'}
			<Button variant="primary" disabled={!projects.projectId || !!projects.busy} onclick={attach}>
				{projects.busy === 'attach' ? 'Attaching…' : 'Attach'}
			</Button>
		{:else if steps.current === 'delete'}
			<Button
				variant="danger"
				disabled={!machine || confirmName !== machine.name || deleting}
				onclick={remove}
			>
				{deleting ? 'Deleting…' : 'Delete'}
			</Button>
		{/if}
	{/snippet}
</StepSheet>

<style>
	.apply {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.name-field {
		flex: 1;
		min-width: 0;
	}

	.name-field :global(input.input) {
		width: 100%;
		height: 1.75rem;
		padding: 0 0.5rem;
		text-align: right;
		background: transparent;
		color: var(--gh-text);
	}

	.name-field :global(input.input:not(:focus)) {
		border-color: transparent;
		box-shadow: none;
	}

	.name-field :global(input.input:hover:not(:focus):not(:disabled)) {
		background: var(--gh-hover);
	}

	.saved {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 1rem;
		margin-left: -0.5rem;
		color: var(--status-success);
	}

	.script {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border-radius: var(--gh-r-control);
		border: 1px solid var(--border-default);
		background: var(--bg-app);
		color: var(--text-default);
		font-size: var(--gh-ui);
		line-height: var(--gh-lh-ui);
		resize: vertical;
		outline: none;
	}

	.script::placeholder {
		color: var(--gh-faint);
	}

	.script:focus {
		border-color: var(--focus-ring-color);
		box-shadow: 0 0 0 2px var(--focus-ring);
	}
</style>
