<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		KeyRound,
		Plus,
		Loader2,
		Trash2,
		Copy,
		Check,
		ChevronRight,
		Pencil,
		BookOpen
	} from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import RenameModal from '$lib/components/RenameModal.svelte';
	import { Alert, Button, EmptyState, Input, Skeleton } from '$lib/components/ui';
	import { motionStagger } from '$lib/utils/motion.svelte';

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

	let showCreate = $state(false);
	let newTokenName = $state('');
	let creating = $state(false);
	let createdToken = $state<string | null>(null);
	let copied = $state(false);

	let deletingId = $state<string | null>(null);
	let showRevokeModal = $state(false);
	let tokenToRevoke = $state<ApiToken | null>(null);

	let renameOpen = $state(false);
	let renaming = $state(false);
	let tokenToRename = $state<ApiToken | null>(null);

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
			setTimeout(() => {
				copied = false;
			}, 2000);
		} catch {
			toasts.add({ title: 'Failed to copy', color: 'error' });
		}
	}

	function closeCreated() {
		createdToken = null;
		showCreate = false;
		copied = false;
	}

	function confirmRevokeToken(token: ApiToken) {
		tokenToRevoke = token;
		showRevokeModal = true;
	}

	async function revokeToken(token: ApiToken) {
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

	function openRename(token: ApiToken) {
		tokenToRename = token;
		renameOpen = true;
	}

	async function renameToken(name: string) {
		if (!tokenToRename) return;
		renaming = true;
		try {
			const response = await apiFetch(`/apiv1/auth/tokens/${tokenToRename.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || 'Failed to rename token');
			}
			toasts.add({ title: 'Token renamed', color: 'success' });
			renameOpen = false;
			tokenToRename = null;
			await fetchTokens();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to rename token',
				color: 'error'
			});
		} finally {
			renaming = false;
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

<div class="settings-body" {@attach motionStagger({ index: 0 })}>
	{#if createdToken}
		<div class="token-created">
			<Alert tone="success" title="Token created">
				{#snippet icon()}<KeyRound size={15} />{/snippet}
				<p class="token-created-note">Copy it now, it won't be shown again.</p>
				<div class="token-created-value-row">
					<code class="code-block token-created-value">{createdToken}</code>
					<Button variant="primary" onclick={copyToken}>
						{#if copied}
							<Check class="h-4 w-4" />
							Copied
						{:else}
							<Copy class="h-4 w-4" />
							Copy
						{/if}
					</Button>
				</div>
				<div class="token-created-actions">
					<Button variant="secondary" size="sm" onclick={closeCreated}>Done</Button>
				</div>
			</Alert>
		</div>
	{/if}

	<section class="settings-section">
		<button
			class="settings-section-trigger"
			onclick={() => {
				showCreate = !showCreate;
			}}
		>
			<div class="settings-section-trigger-left">
				<span class="uat-icon"><Plus class="h-[18px] w-[18px]" /></span>
				<div>
					<p class="settings-section-label">Create new token</p>
					<p class="settings-section-desc">
						Generate a token for CLI tools, MCP server, or API access
					</p>
				</div>
			</div>
			<span class="settings-section-chevron" class:is-open={showCreate}
				><ChevronRight class="h-4 w-4" /></span
			>
		</button>

		{#if showCreate}
			<div class="settings-section-content">
				<p class="settings-hint">
					Tokens have the same permissions as your account. Use them with the Orchard MCP server or
					API.
				</p>
				<div class="token-create-form">
					<Input
						class="flex-1"
						type="text"
						placeholder="Token name (e.g. Claude Code, CI/CD)"
						bind:value={newTokenName}
						onkeydown={(e: KeyboardEvent) => {
							if (e.key === 'Enter') createToken();
						}}
					/>
					<Button
						variant="primary"
						onclick={createToken}
						loading={creating}
						disabled={creating || !newTokenName.trim()}
					>
						Create
					</Button>
				</div>
			</div>
		{/if}
	</section>

	<section class="settings-section">
		<button class="settings-section-trigger" style="cursor: default;">
			<div class="settings-section-trigger-left">
				<span class="uat-icon"><KeyRound class="h-[18px] w-[18px]" /></span>
				<div>
					<p class="settings-section-label">Active tokens</p>
					<div class="settings-section-desc">
						{#if loading}
							<Skeleton width="4rem" height="0.75rem" />
						{:else}
							{tokens.length} token{tokens.length !== 1 ? 's' : ''}
						{/if}
					</div>
				</div>
			</div>
		</button>

		<div class="settings-section-content">
			{#if error}
				<Alert tone="error">{error}</Alert>
			{:else if loading}
				<div class="token-list">
					{#each [1, 2] as _ (_)}
						<div class="token-item token-item--skeleton">
							<div class="token-skeleton-lines">
								<Skeleton width="8rem" height="0.875rem" />
								<Skeleton width="14rem" height="0.6875rem" />
							</div>
							<Skeleton width="1.75rem" height="1.75rem" rounded="var(--radius-xs)" />
						</div>
					{/each}
				</div>
			{:else if tokens.length === 0}
				<EmptyState title="No API tokens yet">
					{#snippet icon()}<KeyRound class="h-6 w-6" />{/snippet}
				</EmptyState>
			{:else}
				<div class="token-list">
					{#each tokens as token (token.id)}
						<div class="token-item">
							<div class="flex-1 min-w-0">
								<p class="token-name">{token.name}</p>
								<p class="token-meta">
									Created {formatTimestamp(token.createdAt)} · Last used {formatTimestamp(
										token.lastUsedAt
									)}
									{#if token.expiresAt}
										· Expires {formatTimestamp(token.expiresAt)}
									{/if}
								</p>
							</div>
							<Button variant="ghost" onclick={() => openRename(token)} title="Rename token">
								<Pencil class="h-3.5 w-3.5" />
							</Button>
							<Button
								variant="ghost"
								onclick={() => confirmRevokeToken(token)}
								disabled={deletingId === token.id}
								title="Revoke token"
								class="uat-revoke"
							>
								{#if deletingId === token.id}
									<Loader2 class="h-3.5 w-3.5 animate-spin" />
								{:else}
									<Trash2 class="h-3.5 w-3.5" />
								{/if}
							</Button>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</section>

	<section class="settings-section">
		<button class="settings-section-trigger" onclick={() => {}} style="cursor: default;">
			<div class="settings-section-trigger-left">
				<span class="uat-icon"><BookOpen class="h-[18px] w-[18px]" /></span>
				<div>
					<p class="settings-section-label">Usage</p>
					<p class="settings-section-desc">How to use your token</p>
				</div>
			</div>
		</button>

		<div class="settings-section-content">
			<div class="usage-block">
				<p class="usage-label">Claude Code / MCP client</p>
				<pre class="code-block usage-code">{`{
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
				<p class="usage-label">API (curl)</p>
				<pre class="code-block usage-code">{`curl -H "Authorization: Bearer orch_..." \\
  https://yourdomain.com/apiv1/auth/me`}</pre>
			</div>
		</div>
	</section>
</div>

{#if tokenToRename}
	<RenameModal
		bind:open={renameOpen}
		title="Rename token"
		value={tokenToRename.name}
		saving={renaming}
		onSave={renameToken}
	/>
{/if}

{#if tokenToRevoke}
	<ConfirmModal
		bind:open={showRevokeModal}
		title={`Revoke "${tokenToRevoke.name}"?`}
		description="Any tools or integrations using this token will <strong>stop working</strong> immediately."
		html
		confirmLabel="Revoke Token"
		onconfirm={() => revokeToken(tokenToRevoke!)}
		oncancel={() => {
			tokenToRevoke = null;
		}}
	/>
{/if}

<style>
	.settings-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	.settings-section {
		border: none;
		border-radius: var(--radius-lg);
		overflow: hidden;
		background-color: var(--bg-raised);
		margin-bottom: var(--space-2);
		box-shadow: var(--elev-1);
	}

	.settings-section-trigger {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: var(--space-5) var(--space-6);
		cursor: pointer;
		background: transparent;
		color: var(--text-default);
		transition: background-color var(--dur-fast) ease;
	}

	.settings-section-trigger:hover {
		background-color: var(--bg-hover);
	}

	.settings-section-trigger-left {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	.uat-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-md);
		flex-shrink: 0;
		background-color: var(--fill-soft);
		color: var(--text-default);
	}

	.settings-section-label {
		font-size: var(--text-title-3);
		font-weight: 600;
		line-height: 1.3;
		color: var(--text-default);
		text-align: left;
		letter-spacing: var(--track-headline);
	}

	.settings-section-desc {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		text-align: left;
		margin-top: 0.125rem;
	}

	.settings-section-chevron {
		color: var(--text-muted);
		transition: transform var(--dur-base) ease;
		flex-shrink: 0;
	}

	.settings-section-chevron.is-open {
		transform: rotate(90deg);
	}

	.settings-section-content {
		padding: 0 var(--space-6) var(--space-6);
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.settings-hint {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}

	.token-created {
		margin-bottom: var(--space-2);
	}

	.token-created-note {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}

	.token-created-value-row {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		margin-top: var(--space-3);
	}

	.token-created-value {
		flex: 1;
		min-width: 0;
		padding: 0.625rem var(--space-3);
		word-break: break-all;
		user-select: all;
		white-space: normal;
	}

	.token-created-actions {
		margin-top: var(--space-3);
	}

	.token-create-form {
		display: flex;
		gap: var(--space-2);
	}

	.token-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.token-item :global(.uat-revoke) {
		color: var(--status-error);
	}

	.token-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		padding: 0.875rem var(--space-4);
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		transition: background-color var(--dur-fast) ease;
	}

	.token-item:hover {
		background-color: var(--fill-quiet);
	}

	.token-item--skeleton:hover {
		background-color: transparent;
	}

	.token-skeleton-lines {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		flex: 1;
	}

	.token-name {
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: 600;
		color: var(--text-default);
		overflow-wrap: anywhere;
	}

	.token-meta {
		font-size: var(--text-footnote);
		font-weight: 600;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		line-height: 1.5;
		margin-top: 0.125rem;
		white-space: normal;
		overflow-wrap: anywhere;
	}

	.usage-block {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.usage-label {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-muted);
	}

	.code-block {
		font-family: var(--font-mono);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		background-color: var(--bg-sunken);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-sm);
		color: var(--text-default);
	}

	.usage-code {
		padding: 0.875rem 1.125rem;
		overflow-x: auto;
		white-space: pre;
		line-height: 1.6;
		margin: 0;
	}

	@media (max-width: 640px) {
		.settings-section-trigger {
			padding: var(--space-4) var(--space-5);
		}

		.settings-section-content {
			padding: 0 var(--space-5) var(--space-5);
		}

		.token-created-value-row {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
