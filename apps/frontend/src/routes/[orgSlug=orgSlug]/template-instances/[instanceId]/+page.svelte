<script lang="ts">
	import { page } from '$app/stores';
	import { onDestroy, onMount } from 'svelte';
	import { apiFetch, toasts, selectedOrganization, subscribeOrgEvents } from '$lib/stores';
	import {
		ArrowLeft,
		LayoutTemplate,
		Trash2,
		Database,
		Server,
		Globe,
		ExternalLink,
		Pencil
	} from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import RenameModal from '$lib/components/RenameModal.svelte';
	import { Button, StatusBadge, resourceStatus, Skeleton } from '$lib/components/ui';

	interface TemplateInstance {
		id: string;
		name: string;
		status: string;
		parameters: Record<string, any>;
		createdAt: string;
		template: {
			id: string;
			name: string;
			displayName: string;
			icon?: string;
			category?: string;
		};
		deployments: { id: string; name: string; status: string; image?: string }[];
		databases: { id: string; name: string; status: string; dbName: string }[];
		ingresses: { id: string; name: string; host: string; path: string }[];
	}

	let instance = $state<TemplateInstance | null>(null);
	let loading = $state(true);
	let deleting = $state(false);
	let error = $state<string | null>(null);
	let showDeleteModal = $state(false);
	let renameOpen = $state(false);
	let renaming = $state(false);

	const orgSlug = $derived($page.params.orgSlug);
	const instanceId = $derived($page.params.instanceId);

	async function fetchInstance() {
		if (!instance) loading = true;
		try {
			const response = await apiFetch(`/apiv1/template-instances/${instanceId}`);
			if (!response.ok) throw new Error('Failed to fetch template instance');
			instance = await response.json();
		} catch (e) {
			if (!instance) error = e instanceof Error ? e.message : 'Failed to load instance';
		} finally {
			loading = false;
		}
	}

	async function renameInstance(name: string) {
		if (!instance) return;
		renaming = true;
		try {
			const response = await apiFetch(`/apiv1/template-instances/${instanceId}/name`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to rename');
			}
			instance = await response.json();
			renameOpen = false;
			toasts.add({ title: 'Template instance renamed', color: 'success' });
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

	async function deleteInstance() {
		if (!instance) return;
		deleting = true;
		try {
			const response = await apiFetch(`/apiv1/template-instances/${instanceId}`, {
				method: 'DELETE'
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to delete');
			}

			toasts.add({
				title: 'Template deleted',
				description: `${instance.name} and all its resources have been removed`,
				color: 'success'
			});

			history.back();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete';
		} finally {
			deleting = false;
		}
	}

	let unsub: (() => void) | null = null;
	let subscribedOrgId: string | null = null;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	$effect(() => {
		const id = $selectedOrganization?.id ?? null;
		if (!id || id === subscribedOrgId) return;
		subscribedOrgId = id;
		unsub?.();
		unsub = subscribeOrgEvents(id, (ev) => {
			if (
				ev.type !== 'deployment.changed' &&
				ev.type !== 'database.changed' &&
				ev.type !== 'project.changed'
			)
				return;
			if (refreshTimer) return;
			refreshTimer = setTimeout(() => {
				refreshTimer = null;
				fetchInstance();
			}, 500);
		});
	});

	$effect(() => {
		const status = instance?.status?.toLowerCase();
		const inFlight = status === 'provisioning' || status === 'pending' || status === 'deploying';
		if (inFlight && !pollTimer) {
			pollTimer = setInterval(fetchInstance, 10_000);
		} else if (!inFlight && pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	});

	onDestroy(() => {
		unsub?.();
		if (refreshTimer) clearTimeout(refreshTimer);
		if (pollTimer) clearInterval(pollTimer);
	});

	onMount(fetchInstance);
</script>

<div class="ti-page">
	{#if loading}
		<div class="ti-skeleton">
			<div class="ti-skel-back">
				<Skeleton width="3.5rem" height="0.875rem" rounded="0.25rem" />
			</div>
			<div class="ti-skel-head">
				<Skeleton width="2.5rem" height="2.5rem" rounded="0.75rem" />
				<div>
					<div class="ti-skel-title">
						<Skeleton width="10rem" height="1.25rem" rounded="0.25rem" />
					</div>
					<Skeleton width="8rem" height="0.75rem" rounded="0.25rem" />
				</div>
			</div>
			<div class="ti-skel-label"><Skeleton width="6rem" height="0.75rem" rounded="0.25rem" /></div>
			<div class="ti-skel-row"><Skeleton width="100%" height="3.5rem" rounded="0.75rem" /></div>
			<Skeleton width="100%" height="3.5rem" rounded="0.75rem" />
		</div>
	{:else if instance}
		<button onclick={() => history.back()} class="ti-back">
			<ArrowLeft class="h-4 w-4" />
			Back
		</button>

		<div class="ti-header">
			<div class="ti-header-info">
				<div class="ti-header-icon">
					<LayoutTemplate class="h-5 w-5" style="color: var(--sidebar-text-active-border)" />
				</div>
				<div>
					<div class="ti-title-row">
						<h1 class="ti-title">{instance.name}</h1>
						<button
							class="ti-rename-btn"
							title="Rename"
							aria-label="Rename template instance"
							onclick={() => (renameOpen = true)}
						>
							<Pencil size={14} />
						</button>
					</div>
					<div class="ti-meta">
						<span>{instance.template.displayName}</span>
						<StatusBadge meta={resourceStatus(instance.status)} />
					</div>
				</div>
			</div>
			<Button variant="danger" loading={deleting} onclick={() => (showDeleteModal = true)}>
				{#if !deleting}<Trash2 class="h-4 w-4" />{/if}
				Delete all resources
			</Button>
		</div>

		{#if error}
			<div class="ti-error">{error}</div>
		{/if}

		<div class="ti-sections">
			{#if instance.deployments.length}
				<div class="ti-section">
					<h2 class="ti-section-title">
						<Server class="h-4 w-4" />
						Deployments ({instance.deployments.length})
					</h2>
					<div class="ti-resource-list">
						{#each instance.deployments as dep (dep.id)}
							<a href="/{orgSlug}/deployments/{dep.id}" class="ti-resource-card">
								<div class="ti-resource-info">
									<span class="ti-resource-name">{dep.name}</span>
									{#if dep.image}
										<span class="ti-resource-detail">{dep.image}</span>
									{/if}
								</div>
								<div class="ti-resource-right">
									<StatusBadge meta={resourceStatus(dep.status)} />
									<ExternalLink class="h-3.5 w-3.5 text-muted" />
								</div>
							</a>
						{/each}
					</div>
				</div>
			{/if}

			{#if instance.databases.length}
				<div class="ti-section">
					<h2 class="ti-section-title">
						<Database class="h-4 w-4" />
						Databases ({instance.databases.length})
					</h2>
					<div class="ti-resource-list">
						{#each instance.databases as db (db.id)}
							<a href="/{orgSlug}/databases/{db.id}" class="ti-resource-card">
								<div class="ti-resource-info">
									<span class="ti-resource-name">{db.name}</span>
									<span class="ti-resource-detail">{db.dbName}</span>
								</div>
								<div class="ti-resource-right">
									<StatusBadge meta={resourceStatus(db.status)} />
									<ExternalLink class="h-3.5 w-3.5 text-muted" />
								</div>
							</a>
						{/each}
					</div>
				</div>
			{/if}

			{#if instance.ingresses.length}
				<div class="ti-section">
					<h2 class="ti-section-title">
						<Globe class="h-4 w-4" />
						Ingresses ({instance.ingresses.length})
					</h2>
					<div class="ti-resource-list">
						{#each instance.ingresses as ing (ing.id)}
							<a
								href="https://{ing.host}{ing.path}"
								target="_blank"
								rel="noopener noreferrer"
								class="ti-resource-card"
							>
								<div class="ti-resource-info">
									<span class="ti-resource-name">{ing.host}{ing.path}</span>
								</div>
								<div class="ti-resource-right">
									<ExternalLink class="h-3.5 w-3.5" style="color: var(--surface-muted)" />
								</div>
							</a>
						{/each}
					</div>
				</div>
			{/if}
		</div>

		<div class="ti-section">
			<h2 class="ti-section-title">Parameters used</h2>
			<div class="ti-params">
				{#each Object.entries(instance.parameters) as [key, value] (key)}
					<div class="ti-param">
						<span class="ti-param-key">{key}</span>
						<span class="ti-param-value">{value}</span>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

{#if instance}
	<ConfirmModal
		bind:open={showDeleteModal}
		title={`Delete "${instance.name}"?`}
		description="This will permanently <strong>delete all resources</strong> created by this template (deployments, databases, and ingresses). This cannot be undone."
		html
		confirmLabel="Delete all"
		onconfirm={deleteInstance}
		oncancel={() => {}}
	/>
	<RenameModal
		bind:open={renameOpen}
		title="Rename template instance"
		value={instance.name}
		saving={renaming}
		onSave={renameInstance}
	/>
{/if}

<style>
	.ti-page {
		max-width: 44rem;
		margin: 0 auto;
		padding: 2.5rem 2.5rem 3rem;
	}

	.ti-skeleton {
		padding: 2.5rem 0;
	}
	.ti-skel-back {
		margin-bottom: 1.5rem;
	}
	.ti-skel-head {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		margin-bottom: 1.5rem;
	}
	.ti-skel-title {
		margin-bottom: 0.375rem;
	}
	.ti-skel-label {
		margin-bottom: 0.75rem;
	}
	.ti-skel-row {
		margin-bottom: 0.5rem;
	}

	.ti-back {
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

	.ti-back:hover {
		color: var(--center-channel-color);
	}

	.ti-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}

	.ti-header-info {
		display: flex;
		gap: 0.75rem;
		align-items: flex-start;
	}

	.ti-header-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.75rem;
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 12%, transparent);
		flex-shrink: 0;
	}

	.ti-title {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--center-channel-color);
		margin: 0;
		letter-spacing: -0.02em;
	}

	.ti-title-row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.ti-rename-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border-radius: 0.45rem;
		color: var(--text-muted);
	}

	.ti-rename-btn:hover {
		background: var(--bg-hover);
		color: var(--text-default);
	}

	.ti-meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin-top: 0.25rem;
	}

	.ti-error {
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
		margin-bottom: 1.5rem;
	}

	.ti-sections {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		margin-bottom: 1.5rem;
	}

	.ti-section {
		margin-bottom: 0.5rem;
	}

	.ti-section-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
		margin: 0 0 0.75rem;
	}

	.ti-resource-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.ti-resource-card {
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
		transition:
			border-color 0.15s,
			box-shadow 0.15s;
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}

	.ti-resource-card:hover {
		border-color: var(--sidebar-text-active-border);
	}

	.ti-resource-info {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.ti-resource-name {
		font-size: 0.875rem;
		font-weight: 500;
	}

	.ti-resource-detail {
		font-size: 0.75rem;
		color: var(--surface-muted);
		font-family: var(--font-mono);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ti-resource-right {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.ti-params {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem;
	}

	.ti-param {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		background-color: color-mix(in srgb, var(--surface-border) 30%, transparent);
	}

	.ti-param-key {
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--surface-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.ti-param-value {
		font-size: 0.875rem;
		color: var(--center-channel-color);
		font-family: var(--font-mono);
		word-break: break-all;
	}
</style>
