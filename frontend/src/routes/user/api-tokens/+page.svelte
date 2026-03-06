<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { ArrowLeft, KeyRound, Plus, Loader2, Trash2, Copy, Check, ChevronRight } from 'lucide-svelte';

	interface ApiToken {
		id: string;
		name: string;
		lastUsedAt: string | null;
		expiresAt: string | null;
		createdAt: string;
	}

	let tokens = $state<ApiToken[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// Create token state
	let showCreate = $state(false);
	let newTokenName = $state('');
	let creating = $state(false);
	let createdToken = $state<string | null>(null);
	let copied = $state(false);

	// Delete state
	let deletingId = $state<string | null>(null);

	async function fetchTokens() {
		loading = true;
		error = null;
		try {
			const response = await apiFetch('/apiv1/auth/tokens');
			if (!response.ok) throw new Error('Failed to load API tokens');
			const data = await response.json();
			tokens = data;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load tokens';
		} finally {
			loading = false;
		}
	}

	async function createToken() {
		if (creating || !newTokenName.trim()) return;
		creating = true;
		try {
			const response = await apiFetch('/apiv1/auth/tokens', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newTokenName.trim() })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || 'Failed to create token');
			}
			const data = await response.json();
			createdToken = data.token;
			newTokenName = '';
			await fetchTokens();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to create token',
				color: 'error'
			});
		} finally {
			creating = false;
		}
	}

	async function copyToken() {
		if (!createdToken) return;
		try {
			await navigator.clipboard.writeText(createdToken);
			copied = true;
			toasts.add({ title: 'Copied to clipboard', color: 'success' });
			setTimeout(() => { copied = false; }, 2000);
		} catch {
			toasts.add({ title: 'Failed to copy', color: 'error' });
		}
	}

	function closeCreated() {
		createdToken = null;
		showCreate = false;
		copied = false;
	}

	async function revokeToken(token: ApiToken) {
		const confirmed = window.confirm(`Revoke "${token.name}"? Any tools using this token will stop working.`);
		if (!confirmed) return;

		deletingId = token.id;
		try {
			const response = await apiFetch(`/apiv1/auth/tokens/${token.id}`, {
				method: 'DELETE'
			});
			if (!response.ok) throw new Error('Failed to revoke token');
			toasts.add({ title: 'Token revoked', color: 'success' });
			await fetchTokens();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to revoke token',
				color: 'error'
			});
		} finally {
			deletingId = null;
		}
	}

	function formatTimestamp(value?: string | null) {
		if (!value) return 'Never';
		return new Date(value).toLocaleString(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		});
	}

	onMount(() => {
		fetchTokens();
	});
</script>

<div class="settings-page">
	<div class="settings-container">
		<!-- Header -->
		<div class="settings-header">
			<button
				onclick={() => window.history.back()}
				class="settings-back-btn"
			>
				<ArrowLeft class="h-4 w-4" />
				Back
			</button>

			<div class="settings-title-row">
				<div class="settings-avatar">
					<KeyRound class="h-5 w-5" />
				</div>
				<div>
					<h1 class="settings-title">API Tokens</h1>
					<p class="settings-subtitle">Manage personal access tokens for the Orchard API and MCP server</p>
				</div>
			</div>
		</div>

		<!-- Created token banner -->
		{#if createdToken}
			<div class="token-created-banner">
				<div class="token-created-header">
					<KeyRound class="h-4 w-4" />
					<p class="token-created-title">Token created — copy it now, it won't be shown again</p>
				</div>
				<div class="token-created-value-row">
					<code class="token-created-value">{createdToken}</code>
					<button class="btn btn-primary" onclick={copyToken}>
						{#if copied}
							<Check class="h-4 w-4" />
							Copied
						{:else}
							<Copy class="h-4 w-4" />
							Copy
						{/if}
					</button>
				</div>
				<button class="btn btn-secondary btn-sm" onclick={closeCreated}>Done</button>
			</div>
		{/if}

		<!-- Create section -->
		<section class="settings-section">
			<button class="settings-section-trigger" onclick={() => { showCreate = !showCreate; }}>
				<div class="settings-section-trigger-left">
					<Plus class="h-4 w-4" />
					<div>
						<p class="settings-section-label">Create new token</p>
						<p class="settings-section-desc">Generate a token for CLI tools, MCP server, or API access</p>
					</div>
				</div>
				<span class="settings-section-chevron" class:is-open={showCreate}><ChevronRight class="h-4 w-4" /></span>
			</button>

			{#if showCreate}
				<div class="settings-section-content">
					<p class="settings-hint">
						Tokens have the same permissions as your account. Use them with the Orchard MCP server or API.
					</p>
					<div class="token-create-form">
						<input
							class="input flex-1"
							type="text"
							placeholder="Token name (e.g. Claude Code, CI/CD)"
							bind:value={newTokenName}
							onkeydown={(e) => { if (e.key === 'Enter') createToken(); }}
						/>
						<button
							class="btn btn-primary"
							onclick={createToken}
							disabled={creating || !newTokenName.trim()}
						>
							{#if creating}<Loader2 class="h-4 w-4 animate-spin" />{/if}
							Create
						</button>
					</div>
				</div>
			{/if}
		</section>

		<!-- Token list -->
		<section class="settings-section">
			<button class="settings-section-trigger" style="cursor: default;">
				<div class="settings-section-trigger-left">
					<KeyRound class="h-4 w-4" />
					<div>
						<p class="settings-section-label">Active tokens</p>
						<p class="settings-section-desc">
							{#if loading}
								Loading...
							{:else}
								{tokens.length} token{tokens.length !== 1 ? 's' : ''}
							{/if}
						</p>
					</div>
				</div>
			</button>

			<div class="settings-section-content">
				{#if error}
					<div class="alert alert-error">{error}</div>
				{:else if loading}
					<div class="flex items-center justify-center py-6">
						<Loader2 class="h-5 w-5 animate-spin text-primary-600" />
					</div>
				{:else if tokens.length === 0}
					<p class="settings-hint" style="text-align: center; padding: 1rem 0;">No API tokens yet. Create one to get started.</p>
				{:else}
					<div class="token-list">
						{#each tokens as token}
							<div class="token-item">
								<div class="flex-1 min-w-0">
									<p class="settings-field-value">{token.name}</p>
									<p class="settings-field-label">
										Created {formatTimestamp(token.createdAt)} · Last used {formatTimestamp(token.lastUsedAt)}
										{#if token.expiresAt}
											 · Expires {formatTimestamp(token.expiresAt)}
										{/if}
									</p>
								</div>
								<button
									class="btn btn-ghost"
									onclick={() => revokeToken(token)}
									disabled={deletingId === token.id}
									title="Revoke token"
									style="color: var(--error-text-color);"
								>
									{#if deletingId === token.id}
										<Loader2 class="h-3.5 w-3.5 animate-spin" />
									{:else}
										<Trash2 class="h-3.5 w-3.5" />
									{/if}
								</button>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</section>

		<!-- Usage instructions -->
		<section class="settings-section">
			<button class="settings-section-trigger" onclick={() => {}} style="cursor: default;">
				<div class="settings-section-trigger-left">
					<div>
						<p class="settings-section-label">Usage</p>
						<p class="settings-section-desc">How to use your token</p>
					</div>
				</div>
			</button>

			<div class="settings-section-content">
				<div class="usage-block">
					<p class="settings-field-label">Claude Code / MCP Client</p>
					<pre class="usage-code">{`{
  "mcpServers": {
    "orchard": {
      "type": "url",
      "url": "https://mcp.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer orch_..."
      }
    }
  }
}`}</pre>
				</div>

				<div class="usage-block">
					<p class="settings-field-label">API (curl)</p>
					<pre class="usage-code">{`curl -H "Authorization: Bearer orch_..." \\
  https://yourdomain.com/apiv1/auth/me`}</pre>
				</div>
			</div>
		</section>
	</div>
</div>

<style>
	.settings-page {
		padding: 2rem;
		max-width: 42rem;
		margin: 0 auto;
	}

	.settings-container {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.settings-header {
		margin-bottom: 1.5rem;
	}

	.settings-back-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		color: var(--surface-muted);
		cursor: pointer;
		margin-bottom: 1rem;
		transition: color 120ms ease;
	}

	.settings-back-btn:hover {
		color: var(--center-channel-color);
	}

	.settings-title-row {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.settings-avatar {
		width: 3rem;
		height: 3rem;
		border-radius: 0.75rem;
		overflow: hidden;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background-color: color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-bg));
		color: var(--center-channel-color);
	}

	.settings-title {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--center-channel-color);
		line-height: 1.3;
	}

	.settings-subtitle {
		font-size: 0.875rem;
		color: var(--surface-muted);
	}

	/* Sections */
	.settings-section {
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		overflow: hidden;
		background-color: var(--surface-bg);
		margin-bottom: 0.5rem;
	}

	.settings-section-trigger {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 1rem 1.25rem;
		cursor: pointer;
		background: transparent;
		color: var(--center-channel-color);
		transition: background-color 120ms ease;
	}

	.settings-section-trigger:hover {
		background-color: var(--control-hover-bg);
	}

	.settings-section-trigger-left {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.settings-section-label {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--center-channel-color);
		text-align: left;
	}

	.settings-section-desc {
		font-size: 0.75rem;
		color: var(--surface-muted);
		text-align: left;
	}

	.settings-section-chevron {
		color: var(--surface-muted);
		transition: transform 200ms ease;
		flex-shrink: 0;
	}

	.settings-section-chevron.is-open {
		transform: rotate(90deg);
	}

	.settings-section-content {
		padding: 0 1.25rem 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		border-top: 1px solid var(--surface-border);
		padding-top: 1rem;
	}

	.settings-field-label {
		font-size: 0.6875rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--surface-muted);
	}

	.settings-field-value {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.settings-hint {
		font-size: 0.8125rem;
		color: var(--surface-muted);
	}

	/* Token created banner */
	.token-created-banner {
		border: 1px solid var(--online-indicator);
		border-radius: 1rem;
		padding: 1.25rem;
		margin-bottom: 0.5rem;
		background-color: color-mix(in srgb, var(--online-indicator) 8%, var(--center-channel-bg));
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.token-created-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--online-indicator);
		font-weight: 600;
		font-size: 0.875rem;
	}

	.token-created-title {
		font-size: 0.8125rem;
		font-weight: 600;
	}

	.token-created-value-row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.token-created-value {
		flex: 1;
		font-size: 0.75rem;
		font-family: monospace;
		padding: 0.625rem 0.75rem;
		border-radius: 0.5rem;
		background-color: var(--surface-bg);
		border: 1px solid var(--surface-border);
		color: var(--center-channel-color);
		word-break: break-all;
		user-select: all;
	}

	/* Create form */
	.token-create-form {
		display: flex;
		gap: 0.5rem;
	}

	/* Token list */
	.token-list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.token-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
	}

	/* Usage blocks */
	.usage-block {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.usage-code {
		font-size: 0.75rem;
		font-family: monospace;
		padding: 0.75rem 1rem;
		border-radius: 0.5rem;
		background-color: color-mix(in srgb, var(--surface-border) 30%, var(--center-channel-bg));
		border: 1px solid var(--surface-border);
		color: var(--center-channel-color);
		overflow-x: auto;
		white-space: pre;
		line-height: 1.5;
		margin: 0;
	}
</style>
