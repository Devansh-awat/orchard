<script lang="ts">
	import { ExternalLink, Trash2 } from 'lucide-svelte';
	import { Button, Field, Modal, Select } from '$lib/components/ui';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import { previewStatus } from '$lib/components/ui/status';
	import { organizations, toasts } from '$lib/stores';
	import * as api from './api';
	import FormError from './FormError.svelte';
	import { getGreenhouseApp } from './app.svelte';
	import { hostOnly } from './workspace.svelte';
	import type { GhOrchardProject, GhPreviewResult } from './types';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const session = $derived(ws?.session ?? null);
	const owner = $derived(ws?.isOwner ?? false);
	const orgId = $derived(app.machine?.organizationId ?? app.organizationId ?? null);
	const hasPreview = $derived(!!session?.previewDeploymentId || !!session?.previewUrl);
	const meta = $derived(previewStatus(session?.previewStatus));

	let projects = $state.raw<GhOrchardProject[]>([]);
	let phase = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let projectId = $state('');
	let deploymentId = $state('');
	let busy = $state<'deploy' | 'remove' | null>(null);
	let result = $state.raw<GhPreviewResult | null>(null);
	let error = $state<string | null>(null);

	const project = $derived(projects.find((p) => p.id === projectId) ?? null);
	const remembered = $derived(app.machine ? `greenhouse-preview-project:${app.machine.id}` : null);

	let loadedFor: string | null = null;
	$effect(() => {
		if (!open || !orgId || orgId === loadedFor) return;
		loadedFor = orgId;
		void load(orgId);
	});

	let openedFor: string | null = null;
	$effect(() => {
		const id = open ? (session?.id ?? null) : null;
		if (id === openedFor) return;
		openedFor = id;
		result = null;
		error = null;
	});

	async function load(org: string) {
		phase = 'loading';
		const role = $organizations.find((o) => o.id === org)?.myRole ?? null;
		const res = await api.listEditableProjects(org, {
			userId: app.self?.id ?? null,
			orgRole: role,
			superAdmin: app.superAdmin
		});
		if (!res.ok) {
			phase = 'error';
			return;
		}
		projects = res.data;
		phase = 'ready';
		const last = remembered ? localStorage.getItem(remembered) : null;
		projectId = res.data.find((p) => p.id === last)?.id ?? res.data[0]?.id ?? '';
	}

	function pickProject(id: string) {
		projectId = id;
		deploymentId = '';
	}

	async function deploy() {
		const current = session;
		if (!ws || !current || !projectId || busy) return;
		busy = 'deploy';
		error = null;
		try {
			const res = await api.previewDeploy(ws.sandboxId, current.id, {
				projectId,
				deploymentId: deploymentId || null
			});
			ws.upsert(res.session);
			result = res;
			if (remembered) localStorage.setItem(remembered, projectId);
			toasts.add({
				title: res.redeployed ? 'Preview redeploying' : 'Preview deploying',
				description: `${res.branch}${res.commit ? ` at ${res.commit.slice(0, 7)}` : ''}`,
				color: 'success'
			});
		} catch (e) {
			error = e instanceof Error ? e.message : 'The deploy did not start';
		} finally {
			busy = null;
		}
	}

	async function remove() {
		const current = session;
		if (!ws || !current || busy) return;
		busy = 'remove';
		if (await ws.removePreview(current)) result = null;
		busy = null;
	}
</script>

<Modal bind:open title="Deploy a preview" size="md">
	{#if session && ws}
		<div class="form">
			<p class="lead">
				Pushes <span class="gh-mono">{session.branch}</span> and deploys it to its own preview environment
				in an Orchard project. Deploying again rebuilds the latest commit.
			</p>

			{#if hasPreview}
				<div class="current" data-align="preview-row">
					<span class="ico"><StatusDot {meta} size={8} /></span>
					<span class="current-label">{meta.label}</span>
					{#if session.previewUrl}
						<a class="url gh-mono" href={session.previewUrl} target="_blank" rel="noopener"
							>{session.previewUrl.replace(/^https?:\/\//, '')}</a
						>
						<a
							class="gh-ibtn"
							href={session.previewUrl}
							target="_blank"
							rel="noopener"
							aria-label="Open the preview"
							title="Open the preview"
						>
							<ExternalLink size={16} strokeWidth={1.75} />
						</a>
					{:else}
						<span class="url url--pending">The address appears once it is routed</span>
					{/if}
					<button
						type="button"
						class="gh-ibtn"
						aria-label="Remove preview"
						title={owner ? 'Remove preview' : hostOnly('remove previews')}
						disabled={!owner || !!busy}
						onclick={remove}
					>
						<Trash2 size={16} strokeWidth={1.75} />
					</button>
				</div>
			{/if}

			{#if phase === 'loading' || phase === 'idle'}
				<p class="note">Loading projects…</p>
			{:else if phase === 'error'}
				<p class="note">Could not load the projects in this organization.</p>
			{:else if projects.length === 0}
				<p class="note">
					There is no project in this organization you can deploy to. Create one in Orchard, or ask
					its admin to make you a member.
				</p>
			{:else}
				<Field label="Project" for="gh-preview-project">
					<Select
						id="gh-preview-project"
						value={projectId}
						disabled={!owner}
						onchange={(e: Event) => pickProject((e.currentTarget as HTMLSelectElement).value)}
					>
						{#each projects as p (p.id)}
							<option value={p.id}>{p.name}</option>
						{/each}
					</Select>
				</Field>
				<Field
					label="Copy settings from"
					hint="Build settings, variables and port come from this deployment"
					for="gh-preview-source"
				>
					<Select id="gh-preview-source" bind:value={deploymentId} disabled={!owner || !project}>
						<option value="">The one building {session.repo}</option>
						{#each project?.deployments ?? [] as d (d.id)}
							<option value={d.id}>{d.displayName || d.name}</option>
						{/each}
					</Select>
				</Field>
			{/if}

			{#if result && result.skippedEnv.length > 0}
				<p class="note">
					Left out {result.skippedEnv.length === 1
						? 'one variable'
						: `${result.skippedEnv.length} variables`}
					bound to resources of the source:
					<span class="gh-mono">{result.skippedEnv.join(', ')}</span>.
				</p>
			{/if}
			{#if error}<FormError message={error} />{/if}
			{#if !owner}<p class="note">{hostOnly('deploy previews')}.</p>{/if}
		</div>
	{/if}
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (open = false)}>Close</Button>
		<Button
			variant="primary"
			disabled={!owner || !projectId || !!busy || phase !== 'ready'}
			onclick={deploy}
		>
			{busy === 'deploy' ? 'Deploying…' : hasPreview ? 'Redeploy' : 'Deploy preview'}
		</Button>
	{/snippet}
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.lead,
	.note {
		margin: 0;
	}

	.lead {
		color: var(--text-muted);
	}

	.note {
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-muted);
	}

	.current {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2.5rem;
		padding: 0.25rem calc(0.75rem - var(--gh-ibtn-inset)) 0.25rem 0.75rem;
		border-radius: var(--gh-r-row);
		border: 1px solid var(--gh-line);
		background: var(--gh-field);
	}

	.ico {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--gh-glyph);
		height: var(--gh-glyph);
	}

	.current-label {
		flex: none;
		font-weight: 600;
	}

	.url {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-muted);
	}

	a.url:hover {
		color: var(--text-default);
		text-decoration: underline;
	}

	.url--pending {
		font-family: inherit;
		color: var(--text-faint);
	}
</style>
