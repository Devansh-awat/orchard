<script lang="ts">
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import { apiFetch, toasts, selectedOrganization, subscribeOrgEvents } from '$lib/stores';
	import {
		ArrowLeft,
		Loader2,
		FileText,
		Trash2,
		Server,
		ExternalLink,
		Github,
		RefreshCw,
		Pencil
	} from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import RenameModal from '$lib/components/RenameModal.svelte';
	import { resourceStatus } from '$lib/components/ui';

	interface ChildDeployment {
		id: string;
		name: string;
		status: string;
		image?: string;
		buildStatus?: string;
		buildStep?: string;
		composeServiceName?: string;
	}

	interface ComposeStack {
		id: string;
		projectId: string;
		name: string;
		composeYaml: string;
		status: string;
		lastError?: string | null;
		githubRepo?: string | null;
		githubBranch?: string | null;
		composePath?: string | null;
		autoDeployEnabled: boolean;
		autoDeployBranch?: string | null;
		lastCommitSha?: string | null;
		createdAt: string;
		deployments: ChildDeployment[];
	}

	let stack = $state<ComposeStack | null>(null);
	let loading = $state(true);
	let deleting = $state(false);
	let redeploying = $state(false);
	let renameOpen = $state(false);
	let renaming = $state(false);
	let togglingAutoDeploy = $state(false);
	let error = $state<string | null>(null);
	let showDeleteModal = $state(false);

	const orgSlug = $derived($page.params.orgSlug);
	const stackId = $derived($page.params.stackId);

	function githubRepoLabel(url: string | null | undefined): string {
		if (!url) return '—';
		try {
			const u = new URL(url);
			return u.pathname.replace(/^\/+|\.git$/g, '');
		} catch {
			return url;
		}
	}

	async function fetchStack() {
		if (!stack) loading = true;
		try {
			const response = await apiFetch(`/apiv1/compose-stacks/${stackId}`);
			if (!response.ok) throw new Error('Failed to fetch compose stack');
			stack = await response.json();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load stack';
		} finally {
			loading = false;
		}
	}

	async function redeploy() {
		if (!stack) return;
		redeploying = true;
		error = null;
		try {
			const response = await apiFetch(`/apiv1/compose-stacks/${stackId}/redeploy`, {
				method: 'POST'
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to redeploy');
			}
			stack = await response.json();
			toasts.add({
				title: 'Redeployed',
				description: 'Pulled fresh compose from GitHub',
				color: 'success'
			});
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to redeploy';
		} finally {
			redeploying = false;
		}
	}

	async function toggleAutoDeploy() {
		if (!stack) return;
		togglingAutoDeploy = true;
		try {
			const response = await apiFetch(`/apiv1/compose-stacks/${stackId}/auto-deploy`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: !stack.autoDeployEnabled })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to update auto-deploy');
			}
			const updated: ComposeStack = await response.json();
			stack = updated;
			toasts.add({
				title: updated.autoDeployEnabled ? 'Auto-deploy enabled' : 'Auto-deploy disabled',
				color: 'success'
			});
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to update auto-deploy';
		} finally {
			togglingAutoDeploy = false;
		}
	}

	async function renameStack(name: string) {
		if (!stack) return;
		renaming = true;
		try {
			const response = await apiFetch(`/apiv1/compose-stacks/${stackId}/name`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to rename');
			}
			const updated: ComposeStack = await response.json();
			stack = updated;
			renameOpen = false;
			toasts.add({ title: 'Stack renamed', color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to rename',
				color: 'error'
			});
		} finally {
			renaming = false;
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
				color: 'success'
			});
			history.back();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete';
		} finally {
			deleting = false;
		}
	}

	onMount(fetchStack);

	let sseUnsub: (() => void) | null = null;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	let subscribedOrgId: string | null = null;
	$effect(() => {
		const id = $selectedOrganization?.id ?? null;
		if (!id || id === subscribedOrgId) return;
		subscribedOrgId = id;
		sseUnsub?.();
		sseUnsub = subscribeOrgEvents(id, (ev) => {
			if (
				ev.type !== 'deployment.changed' &&
				ev.type !== 'build.changed' &&
				ev.type !== 'project.changed'
			)
				return;
			const projectId = stack?.projectId;
			if (!projectId) return;
			const relevant =
				ev.projectId === projectId || (ev.type === 'project.changed' && ev.id === projectId);
			if (!relevant) return;
			if (refreshTimer) return;
			refreshTimer = setTimeout(() => {
				refreshTimer = null;
				fetchStack();
			}, 2000);
		});
	});

	onDestroy(() => {
		sseUnsub?.();
		if (refreshTimer) clearTimeout(refreshTimer);
	});
</script>

<div class="cs-page">
	{#if loading}
		<div class="cs-skeleton">
			<div class="skeleton" style="width: 3.5rem; height: 0.875rem; margin-bottom: 1.5rem;"></div>
			<div
				class="skeleton"
				style="width: 100%; height: 4rem; border-radius: var(--radius-md); margin-bottom: 1rem;"
			></div>
			<div
				class="skeleton"
				style="width: 100%; height: 12rem; border-radius: var(--radius-md);"
			></div>
		</div>
	{:else if stack}
		<button onclick={() => history.back()} class="cs-back">
			<ArrowLeft class="h-4 w-4" /> Back
		</button>

		<div class="cs-header">
			<div class="cs-header-info">
				<div class="cs-header-icon">
					<FileText class="h-5 w-5" style="color: var(--hue-blue)" />
				</div>
				<div>
					<div class="cs-title-row">
						<h1 class="cs-title">{stack.name}</h1>
						<button
							class="cs-rename-btn"
							title="Rename"
							aria-label="Rename stack"
							onclick={() => (renameOpen = true)}
						>
							<Pencil size={14} />
						</button>
					</div>
					<p class="cs-meta">
						Compose stack &middot;
						<span class="cs-status status--{resourceStatus(stack.status).kind}"
							>{resourceStatus(stack.status).label}</span
						>
					</p>
				</div>
			</div>
			<div class="cs-header-actions">
				<button onclick={redeploy} disabled={redeploying} class="cs-btn cs-btn-secondary">
					{#if redeploying}
						<Loader2 class="h-4 w-4 animate-spin" /> Redeploying…
					{:else}
						<RefreshCw class="h-4 w-4" /> Redeploy
					{/if}
				</button>
				<button
					onclick={() => (showDeleteModal = true)}
					disabled={deleting}
					class="cs-btn cs-btn-danger"
				>
					{#if deleting}
						<Loader2 class="h-4 w-4 animate-spin" /> Deleting…
					{:else}
						<Trash2 class="h-4 w-4" /> Delete
					{/if}
				</button>
			</div>
		</div>

		{#if error}
			<div class="cs-error">{error}</div>
		{/if}

		{#if stack.lastError && stack.status === 'failed'}
			<div class="cs-error"><strong>Last error:</strong> {stack.lastError}</div>
		{/if}

		<div class="cs-section">
			<h2 class="cs-section-title">
				<Github class="h-4 w-4" style="color: var(--surface-muted)" /> Source
			</h2>
			<div class="cs-source-card">
				<dl class="cs-source-grid">
					<div>
						<dt>Repository</dt>
						<dd>
							{#if stack.githubRepo}
								<a
									href={stack.githubRepo}
									target="_blank"
									rel="noopener noreferrer"
									class="cs-link"
								>
									{githubRepoLabel(stack.githubRepo)}
									<ExternalLink class="h-3 w-3" />
								</a>
							{:else}
								<span class="cs-muted">—</span>
							{/if}
						</dd>
					</div>
					<div>
						<dt>Branch</dt>
						<dd><span class="cs-mono">{stack.githubBranch ?? '—'}</span></dd>
					</div>
					<div>
						<dt>Compose file</dt>
						<dd><span class="cs-mono">{stack.composePath ?? 'docker-compose.yml'}</span></dd>
					</div>
					<div>
						<dt>Last commit</dt>
						<dd>
							<span class="cs-mono">{stack.lastCommitSha?.substring(0, 7) ?? '—'}</span>
						</dd>
					</div>
				</dl>
				<label class="cs-toggle">
					<input
						type="checkbox"
						checked={stack.autoDeployEnabled}
						disabled={togglingAutoDeploy}
						onchange={toggleAutoDeploy}
					/>
					<span class="cs-toggle-label">
						<span class="cs-toggle-title">
							Auto-deploy on push to <span class="cs-mono"
								>{stack.autoDeployBranch ?? stack.githubBranch ?? '—'}</span
							>
						</span>
						<span class="cs-toggle-desc">
							Each <code>build:</code> service rebuilds independently when a commit lands.
						</span>
					</span>
				</label>
			</div>
		</div>

		<div class="cs-section">
			<h2 class="cs-section-title">
				<Server class="h-4 w-4" style="color: #3b82f6" /> Services ({stack.deployments.length})
			</h2>
			<div class="cs-resource-list">
				{#each stack.deployments as dep (dep.id)}
					<a href="/{orgSlug}/deployments/{dep.id}" class="cs-resource-card">
						<div class="cs-resource-info">
							<span class="cs-resource-name">{dep.composeServiceName ?? dep.name}</span>
							{#if dep.image}
								<span class="cs-resource-detail">{dep.image}</span>
							{/if}
						</div>
						<div class="cs-resource-right">
							{#if dep.buildStatus === 'building'}
								<span class="cs-resource-status status--progress">
									<Loader2 class="h-3 w-3 animate-spin" /> building
								</span>
							{:else}
								{@const m = resourceStatus(dep.status)}
								<span class="cs-resource-status status--{m.kind}">
									{m.label}
								</span>
							{/if}
							<ExternalLink class="h-3.5 w-3.5 text-muted" />
						</div>
					</a>
				{:else}
					<p class="cs-empty">No services in this stack.</p>
				{/each}
			</div>
		</div>

		<div class="cs-section">
			<h2 class="cs-section-title">
				<FileText class="h-4 w-4" style="color: #0db7ed" /> docker-compose.yml
			</h2>
			<pre class="cs-yaml-view cs-mono">{stack.composeYaml}</pre>
			<p class="cs-hint">
				This is the compose file Orchard last fetched from GitHub. To change it, edit the file in
				your repo and click <strong>Redeploy</strong>, or push to the auto-deploy branch.
			</p>
		</div>
	{/if}
</div>

{#if stack}
	<ConfirmModal
		bind:open={showDeleteModal}
		title={`Delete "${stack.name}"?`}
		description="This will permanently <strong>delete all services</strong> in this compose stack. This cannot be undone."
		html
		confirmLabel="Delete stack"
		onconfirm={deleteStack}
		oncancel={() => {}}
	/>
	<RenameModal
		bind:open={renameOpen}
		title="Rename stack"
		value={stack.name}
		saving={renaming}
		onSave={renameStack}
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
		gap: 0.5rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--surface-muted);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
		margin-bottom: 1.5rem;
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

	.cs-header-actions {
		display: flex;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.cs-header-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--radius-md);
		background-color: color-mix(in srgb, #0db7ed 12%, transparent);
		flex-shrink: 0;
	}

	.cs-title {
		font-size: var(--text-title-3);
		line-height: var(--lh-title-3);
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.02em;
	}

	.cs-title-row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.cs-rename-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border-radius: var(--radius-sm);
		color: var(--text-muted);
	}

	.cs-rename-btn:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.cs-meta {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--surface-muted);
		margin: 0.25rem 0 0;
	}

	.cs-status {
		font-weight: 600;
		text-transform: capitalize;
	}

	.cs-error {
		padding: 0.75rem 1rem;
		border-radius: var(--radius-md);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
		margin-bottom: 1.5rem;
	}

	.cs-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.875rem;
		border-radius: var(--radius-sm);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		border: 1px solid transparent;
		cursor: pointer;
		transition:
			opacity var(--dur-fast),
			background-color var(--dur-fast),
			border-color var(--dur-fast);
		white-space: nowrap;
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

	.cs-section-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
		margin: 0 0 0.75rem;
	}

	.cs-source-card {
		border: 1px solid var(--surface-border);
		border-radius: var(--radius-lg);
		background-color: var(--surface-bg);
		padding: 1rem 1.125rem;
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.cs-source-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.75rem 1rem;
		margin: 0;
	}

	.cs-source-grid dt {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--surface-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin: 0;
	}

	.cs-source-grid dd {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--center-channel-color);
		margin: 0.125rem 0 0;
	}

	.cs-link {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		color: var(--sidebar-text-active-border);
		text-decoration: none;
	}

	.cs-link:hover {
		text-decoration: underline;
	}

	.cs-muted {
		color: var(--surface-muted);
	}

	.cs-toggle {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem 0.75rem;
		border-radius: var(--radius-sm);
		background-color: color-mix(in srgb, var(--surface-border) 20%, transparent);
		cursor: pointer;
	}

	.cs-toggle input {
		margin-top: 0.25rem;
	}

	.cs-toggle-label {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.cs-toggle-title {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.cs-toggle-desc {
		font-size: var(--text-caption);
		color: var(--surface-muted);
		line-height: 1.45;
	}

	.cs-toggle-desc code,
	.cs-toggle-title code {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		padding: 0.0625rem 0.25rem;
		border-radius: var(--radius-xs);
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
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
		border-radius: var(--radius-md);
		background-color: var(--surface-bg);
		text-decoration: none;
		color: var(--center-channel-color);
		transition: border-color var(--dur-fast);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
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
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
	}

	.cs-resource-detail {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
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
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		text-transform: capitalize;
	}

	.cs-empty {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--surface-muted);
		padding: 1rem;
		text-align: center;
		border: 1px dashed var(--surface-border);
		border-radius: var(--radius-md);
		margin: 0;
	}

	.cs-yaml-view {
		width: 100%;
		padding: 0.875rem 1rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--surface-border);
		background-color: color-mix(in srgb, var(--surface-border) 18%, var(--surface-bg));
		color: var(--center-channel-color);
		font-size: var(--text-footnote);
		line-height: 1.55;
		overflow-x: auto;
		white-space: pre;
		margin: 0;
	}

	.cs-mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	}

	.cs-hint {
		font-size: var(--text-caption);
		color: var(--surface-muted);
		margin: 0.5rem 0 0;
		line-height: 1.5;
	}
</style>
