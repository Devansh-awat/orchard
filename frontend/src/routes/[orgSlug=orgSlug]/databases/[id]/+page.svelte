<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { apiFetch, toasts, refreshTree } from '$lib/stores';
	import {
		ArrowLeft,
		Loader2,
		Database,
		Trash2,
		Copy,
		Check,
		Eye,
		EyeOff,
		AlertTriangle,
		X
	} from 'lucide-svelte';
	import { fade, scale } from 'svelte/transition';

	interface DatabaseDetail {
		id: string;
		name: string;
		dbName: string;
		dbUser: string;
		dbPassword: string;
		host: string;
		port: number;
		status: string;
		connectionString: string;
		internalHost: string;
		createdAt: string;
		liveStatus?: {
			exists: boolean;
			size?: string;
			connections?: number;
		};
		project?: {
			id: string;
			name: string;
			slug: string;
			workspace?: {
				slug: string;
				organization?: {
					slug: string;
				};
			};
		};
		creator?: {
			username: string;
			email: string;
		};
	}

	let database = $state<DatabaseDetail | null>(null);
	let loading = $state(true);
	let deleting = $state(false);
	let error = $state<string | null>(null);
	let showPassword = $state(false);
	let showConnectionString = $state(false);
	let copiedField = $state<string | null>(null);

	// Delete confirmation modal state
	let showDeleteModal = $state(false);
	let deleteCountdownActive = $state(false);
	let deleteCountdown = $state(10);
	let deleteTimerInterval = $state<ReturnType<typeof setInterval> | null>(null);
	let deleteProgress = $derived(((10 - deleteCountdown) / 10) * 100);

	const dbId = $derived($page.params.id);
	const orgSlug = $derived($page.params.orgSlug);

	async function fetchDatabase() {
		loading = true;
		error = null;
		try {
			const response = await apiFetch(`/apiv1/databases/${dbId}`);
			if (!response.ok) throw new Error('Failed to fetch database');
			database = await response.json();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load database';
		} finally {
			loading = false;
		}
	}

	function openDeleteModal() {
		if (!database) return;
		showDeleteModal = true;
		deleteCountdownActive = false;
		deleteCountdown = 10;
	}

	function startDeleteCountdown() {
		deleteCountdownActive = true;
		deleteCountdown = 10;
		deleteTimerInterval = setInterval(() => {
			deleteCountdown -= 1;
			if (deleteCountdown <= 0) {
				clearInterval(deleteTimerInterval!);
				deleteTimerInterval = null;
				executeDelete();
			}
		}, 1000);
	}

	function cancelDelete() {
		showDeleteModal = false;
		deleteCountdownActive = false;
		if (deleteTimerInterval) {
			clearInterval(deleteTimerInterval);
			deleteTimerInterval = null;
		}
		deleteCountdown = 10;
	}

	async function executeDelete() {
		if (!database) return;
		if (deleteTimerInterval) {
			clearInterval(deleteTimerInterval);
			deleteTimerInterval = null;
		}
		showDeleteModal = false;
		deleteCountdownActive = false;
		deleting = true;

		try {
			const response = await apiFetch(`/apiv1/databases/${dbId}`, { method: 'DELETE' });
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to delete database');
			}

			toasts.add({
				title: 'Database deleted',
				description: `${database.name} has been deleted`,
				color: 'success'
			});

			refreshTree();
			const ws = database.project?.workspace;
			if (ws) {
				goto(`/${orgSlug}/workspaces/${ws.slug}/projects/${database.project!.slug}`);
			} else {
				goto(`/${orgSlug}`);
			}
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to delete',
				color: 'error'
			});
		} finally {
			deleting = false;
		}
	}

	function copyToClipboard(text: string, field: string) {
		navigator.clipboard.writeText(text);
		copiedField = field;
		setTimeout(() => { copiedField = null; }, 2000);
	}

	onMount(fetchDatabase);
</script>

<div class="db-page">
	{#if loading}
		<div class="db-loading">
			<Loader2 class="h-6 w-6 animate-spin" />
			<span>Loading...</span>
		</div>
	{:else if error}
		<div class="db-error">{error}</div>
	{:else if database}
		{@const db = database}
		{#if db.project && db.project.workspace}
			<button
				onclick={() => goto(`/${orgSlug}/workspaces/${db.project!.workspace!.slug}/projects/${db.project!.slug}`)}
				class="db-back"
			>
				<ArrowLeft class="h-4 w-4" />
				{db.project.name}
			</button>
		{/if}

		<div class="db-header">
			<div class="db-header-info">
				<div class="db-header-title-row">
					<div class="db-icon-badge">
						<Database size={16} />
					</div>
					<h1 class="db-title">{database.name}</h1>
					<span class="db-status db-status-{database.status}">{database.status}</span>
				</div>
			</div>
			<button
				onclick={openDeleteModal}
				disabled={deleting}
				class="db-btn db-btn-danger"
			>
				{#if deleting}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<Trash2 class="h-4 w-4" />
				{/if}
				Delete
			</button>
		</div>

		{#if database.liveStatus}
			<div class="db-stats">
				<div class="db-stat">
					<span class="db-stat-label">Size</span>
					<span class="db-stat-value">{database.liveStatus.size ?? 'N/A'}</span>
				</div>
				<div class="db-stat">
					<span class="db-stat-label">Connections</span>
					<span class="db-stat-value">{database.liveStatus.connections ?? 0}</span>
				</div>
				<div class="db-stat">
					<span class="db-stat-label">Port</span>
					<span class="db-stat-value">{database.port}</span>
				</div>
			</div>
		{/if}

		<div class="db-section">
			<h2 class="db-section-title">Connection Details</h2>
			<div class="db-credentials">
				<div class="db-cred-row">
					<span class="db-cred-label">Host (internal)</span>
					<div class="db-cred-value-row">
						<code class="db-cred-value">{database.host}</code>
						<button class="db-copy-btn" onclick={() => copyToClipboard(db.host, 'host')}>
							{#if copiedField === 'host'}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
						</button>
					</div>
				</div>
				<div class="db-cred-row">
					<span class="db-cred-label">Port</span>
					<div class="db-cred-value-row">
						<code class="db-cred-value">{database.port}</code>
						<button class="db-copy-btn" onclick={() => copyToClipboard(String(db.port), 'port')}>
							{#if copiedField === 'port'}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
						</button>
					</div>
				</div>
				<div class="db-cred-row">
					<span class="db-cred-label">Database</span>
					<div class="db-cred-value-row">
						<code class="db-cred-value">{database.dbName}</code>
						<button class="db-copy-btn" onclick={() => copyToClipboard(db.dbName, 'dbName')}>
							{#if copiedField === 'dbName'}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
						</button>
					</div>
				</div>
				<div class="db-cred-row">
					<span class="db-cred-label">Username</span>
					<div class="db-cred-value-row">
						<code class="db-cred-value">{database.dbUser}</code>
						<button class="db-copy-btn" onclick={() => copyToClipboard(db.dbUser, 'user')}>
							{#if copiedField === 'user'}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
						</button>
					</div>
				</div>
				<div class="db-cred-row">
					<span class="db-cred-label">Password</span>
					<div class="db-cred-value-row">
						<code class="db-cred-value">{showPassword ? db.dbPassword : '••••••••••••'}</code>
						<button class="db-copy-btn" onclick={() => showPassword = !showPassword}>
							{#if showPassword}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye class="h-3.5 w-3.5" />{/if}
						</button>
						<button class="db-copy-btn" onclick={() => copyToClipboard(db.dbPassword, 'password')}>
							{#if copiedField === 'password'}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
						</button>
					</div>
				</div>
			</div>
		</div>

		<div class="db-section">
			<h2 class="db-section-title">Connection String</h2>
			<div class="db-connstr-box">
				<code class="db-connstr">
					{showConnectionString
						? database.connectionString
						: `postgresql://${database.dbUser}:••••••••@${database.host}:${database.port}/${database.dbName}`
					}
				</code>
				<div class="db-connstr-actions">
					<button class="db-copy-btn" onclick={() => showConnectionString = !showConnectionString}>
						{#if showConnectionString}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye class="h-3.5 w-3.5" />{/if}
					</button>
					<button class="db-copy-btn" onclick={() => copyToClipboard(db.connectionString, 'connstr')}>
						{#if copiedField === 'connstr'}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
					</button>
				</div>
			</div>
		</div>

		<div class="db-section">
			<h2 class="db-section-title">Usage in Deployments</h2>
			<p class="db-hint">Add these environment variables to your deployment to connect:</p>
			<div class="db-env-snippet">
				<code>DATABASE_URL={database.connectionString}</code>
			</div>
			<p class="db-hint" style="margin-top: 0.5rem;">Or use individual variables:</p>
			<div class="db-env-snippet">
				<code>DB_HOST={database.host}</code>
				<code>DB_PORT={database.port}</code>
				<code>DB_NAME={database.dbName}</code>
				<code>DB_USER={database.dbUser}</code>
				<code>DB_PASSWORD={database.dbPassword}</code>
			</div>
		</div>
	{/if}
</div>

{#if showDeleteModal && database}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-overlay" transition:fade={{ duration: 150 }} onclick={cancelDelete}>
		<div
			class="modal-card"
			transition:scale={{ duration: 200, start: 0.95 }}
			onclick={(e) => e.stopPropagation()}
		>
			<div class="modal-header">
				<div class="modal-icon-danger">
					<AlertTriangle size={20} />
				</div>
				<button class="modal-close" onclick={cancelDelete}>
					<X size={16} />
				</button>
			</div>

			<h2 class="modal-title">Delete "{database.name}"?</h2>
			<p class="modal-desc">
				This will permanently <strong>drop the PostgreSQL database</strong> and its user.
				All data will be lost. This cannot be undone.
			</p>

			{#if deleteCountdownActive}
				<div class="modal-progress-wrapper">
					<div class="modal-progress-track">
						<div
							class="modal-progress-fill"
							style="width: {deleteProgress}%"
						></div>
					</div>
					<span class="modal-countdown">
						{#if deleteCountdown > 0}
							Deleting in {deleteCountdown}s...
						{:else}
							Deleting now...
						{/if}
					</span>
				</div>

				<div class="modal-actions">
					<button class="db-btn modal-btn-cancel" onclick={cancelDelete}>
						Abort
					</button>
				</div>
			{:else}
				<div class="modal-actions">
					<button class="db-btn modal-btn-cancel" onclick={cancelDelete}>
						Cancel
					</button>
					<button class="db-btn db-btn-danger modal-btn-delete" onclick={startDeleteCountdown}>
						<Trash2 class="h-4 w-4" />
						Delete
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.db-page {
		max-width: 52rem;
		margin: 0 auto;
		padding: 2rem 1.5rem;
	}

	.db-loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 3rem 0;
		color: var(--surface-muted);
		font-size: 0.875rem;
	}

	.db-error {
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		font-size: 0.875rem;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 25%, transparent);
	}

	.db-back {
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

	.db-back:hover {
		color: var(--center-channel-color);
	}

	.db-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}

	.db-header-info {
		flex: 1;
		min-width: 0;
	}

	.db-header-title-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.db-icon-badge {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		background-color: color-mix(in srgb, #22c55e 15%, transparent);
		color: #22c55e;
		flex-shrink: 0;
	}

	.db-title {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.db-status {
		font-size: 0.75rem;
		font-weight: 500;
		padding: 0.25rem 0.625rem;
		border-radius: 9999px;
		text-transform: capitalize;
	}

	.db-status-ready {
		background-color: color-mix(in srgb, #22c55e 15%, transparent);
		color: #22c55e;
	}

	.db-status-pending {
		background-color: color-mix(in srgb, #f59e0b 15%, transparent);
		color: #f59e0b;
	}

	.db-status-error {
		background-color: color-mix(in srgb, var(--error-text-color) 15%, transparent);
		color: var(--error-text-color);
	}

	.db-stats {
		display: flex;
		gap: 0.75rem;
		margin-bottom: 1.5rem;
		flex-wrap: wrap;
	}

	.db-stat {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		padding: 0.625rem 1rem;
		border-radius: 0.75rem;
		background-color: var(--surface-bg);
		border: 1px solid var(--surface-border);
		min-width: 6rem;
	}

	.db-stat-label {
		font-size: 0.6875rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--surface-muted);
	}

	.db-stat-value {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.db-section {
		margin-bottom: 1.5rem;
	}

	.db-section-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0 0 0.75rem;
	}

	.db-credentials {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		overflow: hidden;
	}

	.db-cred-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.625rem 1rem;
		gap: 1rem;
	}

	.db-cred-row:not(:last-child) {
		border-bottom: 1px solid var(--surface-border);
	}

	.db-cred-label {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		flex-shrink: 0;
		min-width: 7rem;
	}

	.db-cred-value-row {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
		flex: 1;
		justify-content: flex-end;
	}

	.db-cred-value {
		font-size: 0.8125rem;
		font-family: monospace;
		color: var(--center-channel-color);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.db-copy-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		flex-shrink: 0;
		transition: color 0.15s, background-color 0.15s;
	}

	.db-copy-btn:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.db-connstr-box {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		border: 1px solid var(--surface-border);
		border-radius: 0.75rem;
		background-color: var(--surface-bg);
	}

	.db-connstr {
		flex: 1;
		font-size: 0.8125rem;
		font-family: monospace;
		color: var(--center-channel-color);
		word-break: break-all;
	}

	.db-connstr-actions {
		display: flex;
		gap: 0.25rem;
		flex-shrink: 0;
	}

	.db-hint {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0 0 0.5rem;
	}

	.db-env-snippet {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		padding: 0.75rem 1rem;
		border-radius: 0.75rem;
		background-color: var(--surface-bg);
		border: 1px solid var(--surface-border);
		font-size: 0.8125rem;
		font-family: monospace;
		color: var(--center-channel-color);
		overflow-x: auto;
	}

	.db-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 500;
		border: none;
		cursor: pointer;
		transition: opacity 0.15s;
		white-space: nowrap;
	}

	.db-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.db-btn-danger {
		background-color: color-mix(in srgb, var(--error-text-color) 12%, transparent);
		color: var(--error-text-color);
	}

	.db-btn-danger:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--error-text-color) 20%, transparent);
	}

	/* Delete confirmation modal */
	.modal-overlay {
		position: fixed;
		inset: 0;
		background-color: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 1rem;
	}

	.modal-card {
		background-color: var(--center-channel-bg);
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		padding: 1.5rem;
		width: 100%;
		max-width: 26rem;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
	}

	.modal-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		margin-bottom: 1rem;
	}

	.modal-icon-danger {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.75rem;
		background-color: color-mix(in srgb, var(--error-text-color) 12%, transparent);
		color: var(--error-text-color);
	}

	.modal-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		transition: color 0.15s, background-color 0.15s;
	}

	.modal-close:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--surface-border) 50%, transparent);
	}

	.modal-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0 0 0.5rem;
	}

	.modal-desc {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0 0 1.25rem;
		line-height: 1.5;
	}

	.modal-desc strong {
		color: var(--error-text-color);
		font-weight: 600;
	}

	.modal-progress-wrapper {
		margin-bottom: 1.25rem;
	}

	.modal-progress-track {
		width: 100%;
		height: 0.375rem;
		border-radius: 9999px;
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		overflow: hidden;
		margin-bottom: 0.5rem;
	}

	.modal-progress-fill {
		height: 100%;
		border-radius: 9999px;
		background-color: var(--error-text-color);
		transition: width 1s linear;
	}

	.modal-countdown {
		font-size: 0.75rem;
		color: var(--surface-muted);
	}

	.modal-actions {
		display: flex;
		gap: 0.5rem;
		justify-content: flex-end;
	}

	.modal-btn-cancel {
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
		color: var(--center-channel-color);
	}

	.modal-btn-cancel:hover {
		background-color: color-mix(in srgb, var(--surface-border) 90%, transparent);
	}

	.modal-btn-delete {
		padding: 0.4375rem 1rem;
	}
</style>
