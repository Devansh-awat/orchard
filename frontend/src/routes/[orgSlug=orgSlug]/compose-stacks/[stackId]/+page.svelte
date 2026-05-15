<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { apiFetch, toasts, refreshTree } from '$lib/stores';
	import {
		ArrowLeft,
		Loader2,
		FileText,
		Trash2,
		Server,
		ExternalLink,
		Save,
		Pencil,
		X
	} from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';

	interface ComposeStack {
		id: string;
		name: string;
		composeYaml: string;
		status: string;
		lastError?: string | null;
		createdAt: string;
		deployments: { id: string; name: string; status: string; image?: string; composeServiceName?: string }[];
	}

	let stack = $state<ComposeStack | null>(null);
	let loading = $state(true);
	let deleting = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let showDeleteModal = $state(false);
	let editing = $state(false);
	let draftYaml = $state('');

	const orgSlug = $derived($page.params.orgSlug);
	const stackId = $derived($page.params.stackId);

	function getStatusColor(status: string) {
		switch (status?.toLowerCase()) {
			case 'active':
			case 'running':
			case 'ready':
				return '#22c55e';
			case 'deploying':
			case 'updating':
			case 'pending':
			case 'building':
				return '#f59e0b';
			case 'failed':
			case 'error':
			case 'deleting':
				return 'var(--error-text-color)';
			default:
				return 'var(--surface-muted)';
		}
	}

	async function fetchStack() {
		loading = true;
		try {
			const response = await apiFetch(`/apiv1/compose-stacks/${stackId}`);
			if (!response.ok) throw new Error('Failed to fetch compose stack');
			stack = await response.json();
			draftYaml = stack?.composeYaml ?? '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load stack';
		} finally {
			loading = false;
		}
	}

	async function saveYaml() {
		if (!stack) return;
		saving = true;
		error = null;
		try {
			const response = await apiFetch(`/apiv1/compose-stacks/${stackId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ composeYaml: draftYaml }),
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to update compose stack');
			}
			stack = await response.json();
			draftYaml = stack?.composeYaml ?? '';
			editing = false;
			refreshTree();
			toasts.add({ title: 'Stack updated', description: 'Redeployed services', color: 'success' });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to update';
		} finally {
			saving = false;
		}
	}

	async function deleteStack() {
		if (!stack) return;
		deleting = true;
		try {
			const response = await apiFetch(`/apiv1/compose-stacks/${stackId}`, { method: 'DELETE' });
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to delete');
			}
			toasts.add({
				title: 'Stack deleted',
				description: `${stack.name} and its services have been removed`,
				color: 'success',
			});
			refreshTree();
			history.back();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete';
		} finally {
			deleting = false;
		}
	}

	onMount(fetchStack);
</script>

<div class="cs-page">
	{#if loading}
		<div class="cs-skeleton">
			<div class="skeleton" style="width: 3.5rem; height: 0.875rem; margin-bottom: 1.5rem;"></div>
			<div class="skeleton" style="width: 100%; height: 4rem; border-radius: 0.75rem; margin-bottom: 1rem;"></div>
			<div class="skeleton" style="width: 100%; height: 12rem; border-radius: 0.75rem;"></div>
		</div>
	{:else if stack}
		<button onclick={() => history.back()} class="cs-back">
			<ArrowLeft class="h-4 w-4" />
			Back
		</button>

		<div class="cs-header">
			<div class="cs-header-info">
				<div class="cs-header-icon">
					<FileText class="h-5 w-5" style="color: #0db7ed" />
				</div>
				<div>
					<h1 class="cs-title">{stack.name}</h1>
					<p class="cs-meta">
						Compose stack &middot;
						<span class="cs-status" style="color: {getStatusColor(stack.status)}">{stack.status}</span>
					</p>
				</div>
			</div>
			<button onclick={() => (showDeleteModal = true)} disabled={deleting} class="cs-btn cs-btn-danger">
				{#if deleting}
					<Loader2 class="h-4 w-4 animate-spin" /> Deleting…
				{:else}
					<Trash2 class="h-4 w-4" /> Delete stack
				{/if}
			</button>
		</div>

		{#if error}
			<div class="cs-error">{error}</div>
		{/if}

		{#if stack.lastError && stack.status === 'failed'}
			<div class="cs-error">
				<strong>Last error:</strong> {stack.lastError}
			</div>
		{/if}

		<div class="cs-section">
			<div class="cs-section-head">
				<h2 class="cs-section-title">
					<Server class="h-4 w-4" style="color: #3b82f6" />
					Services ({stack.deployments.length})
				</h2>
			</div>
			<div class="cs-resource-list">
				{#each stack.deployments as dep}
					<a href="/{orgSlug}/deployments/{dep.id}" class="cs-resource-card">
						<div class="cs-resource-info">
							<span class="cs-resource-name">
								{dep.composeServiceName ?? dep.name}
							</span>
							{#if dep.image}
								<span class="cs-resource-detail">{dep.image}</span>
							{/if}
						</div>
						<div class="cs-resource-right">
							<span class="cs-resource-status" style="color: {getStatusColor(dep.status)}">
								{dep.status}
							</span>
							<ExternalLink class="h-3.5 w-3.5" style="color: var(--surface-muted)" />
						</div>
					</a>
				{:else}
					<p class="cs-empty">No services in this stack.</p>
				{/each}
			</div>
		</div>

		<div class="cs-section">
			<div class="cs-section-head">
				<h2 class="cs-section-title">
					<FileText class="h-4 w-4" style="color: #0db7ed" />
					docker-compose.yml
				</h2>
				{#if editing}
					<div class="cs-section-actions">
						<button
							class="cs-btn cs-btn-secondary cs-btn-sm"
							disabled={saving}
							onclick={() => {
								draftYaml = stack?.composeYaml ?? '';
								editing = false;
							}}
						>
							<X class="h-3.5 w-3.5" /> Cancel
						</button>
						<button class="cs-btn cs-btn-primary cs-btn-sm" disabled={saving} onclick={saveYaml}>
							{#if saving}
								<Loader2 class="h-3.5 w-3.5 animate-spin" /> Saving…
							{:else}
								<Save class="h-3.5 w-3.5" /> Save & redeploy
							{/if}
						</button>
					</div>
				{:else}
					<button class="cs-btn cs-btn-secondary cs-btn-sm" onclick={() => (editing = true)}>
						<Pencil class="h-3.5 w-3.5" /> Edit
					</button>
				{/if}
			</div>
			{#if editing}
				<textarea bind:value={draftYaml} class="cs-textarea cs-mono" spellcheck="false" rows="20"></textarea>
				<p class="cs-hint">
					Saving will <strong>tear down the existing services and redeploy them</strong> from the new compose file. Persistent volumes will be recreated.
				</p>
			{:else}
				<pre class="cs-yaml-view cs-mono">{stack.composeYaml}</pre>
			{/if}
		</div>
	{/if}
</div>

{#if stack}
	<ConfirmModal
		bind:open={showDeleteModal}
		title='Delete "{stack.name}"?'
		description='This will permanently <strong>delete all services</strong> in this compose stack. This cannot be undone.'
		confirmLabel="Delete stack"
		onconfirm={deleteStack}
		oncancel={() => {}}
	/>
{/if}

<style>
	.cs-page {
		max-width: 44rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 3rem;
	}

	.cs-skeleton {
		padding: 2.5rem 0;
	}

	.cs-back {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		color: var(--surface-muted);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
		margin-bottom: 1.5rem;
		transition: color 0.15s;
	}

	.cs-back:hover {
		color: var(--center-channel-color);
	}

	.cs-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}

	.cs-header-info {
		display: flex;
		gap: 0.75rem;
		align-items: flex-start;
	}

	.cs-header-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.75rem;
		background-color: color-mix(in srgb, #0db7ed 12%, transparent);
		flex-shrink: 0;
	}

	.cs-title {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.02em;
	}

	.cs-meta {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0.25rem 0 0;
	}

	.cs-status {
		font-weight: 500;
		text-transform: capitalize;
	}

	.cs-error {
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
		margin-bottom: 1.5rem;
	}

	.cs-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 500;
		border: 1px solid transparent;
		cursor: pointer;
		transition: opacity 0.15s, background-color 0.15s, border-color 0.15s;
		white-space: nowrap;
	}

	.cs-btn-sm {
		padding: 0.25rem 0.625rem;
		font-size: 0.75rem;
	}

	.cs-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.cs-btn-danger {
		background-color: color-mix(in srgb, var(--error-text-color) 12%, transparent);
		color: var(--error-text-color);
	}

	.cs-btn-danger:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--error-text-color) 20%, transparent);
	}

	.cs-btn-primary {
		background-color: var(--sidebar-text-active-border);
		color: white;
	}

	.cs-btn-primary:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 85%, black);
	}

	.cs-btn-secondary {
		border-color: var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
	}

	.cs-btn-secondary:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--surface-border) 30%, transparent);
	}

	.cs-section {
		margin-bottom: 1.75rem;
	}

	.cs-section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
	}

	.cs-section-actions {
		display: flex;
		gap: 0.375rem;
	}

	.cs-section-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
		margin: 0;
	}

	.cs-resource-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.cs-resource-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.875rem 1.125rem;
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		background-color: var(--surface-bg);
		text-decoration: none;
		color: var(--center-channel-color);
		transition: border-color 0.15s, box-shadow 0.15s;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.03), 0 1px 2px rgb(0 0 0 / 0.02);
	}

	.cs-resource-card:hover {
		border-color: var(--sidebar-text-active-border);
	}

	.cs-resource-info {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.cs-resource-name {
		font-size: 0.875rem;
		font-weight: 500;
	}

	.cs-resource-detail {
		font-size: 0.75rem;
		color: var(--surface-muted);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.cs-resource-right {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.cs-resource-status {
		font-size: 0.75rem;
		font-weight: 500;
		text-transform: capitalize;
	}

	.cs-empty {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		padding: 1rem;
		text-align: center;
		border: 1px dashed var(--surface-border);
		border-radius: 0.75rem;
		margin: 0;
	}

	.cs-textarea {
		width: 100%;
		padding: 0.75rem 0.875rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		line-height: 1.5;
		min-height: 18rem;
		resize: vertical;
	}

	.cs-textarea:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 15%, transparent);
	}

	.cs-yaml-view {
		width: 100%;
		padding: 0.875rem 1rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: color-mix(in srgb, var(--surface-border) 18%, var(--surface-bg));
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		line-height: 1.55;
		overflow-x: auto;
		white-space: pre;
		margin: 0;
	}

	.cs-mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
	}

	.cs-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0.5rem 0 0;
		line-height: 1.5;
	}
</style>
