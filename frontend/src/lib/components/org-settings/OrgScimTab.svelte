<script lang="ts">
	import { Loader2, Link2, Copy, Check, Trash2, KeyRound, TriangleAlert } from 'lucide-svelte';
	import { UserCog } from '@jis3r/icons';
	import SettingsSection from '$lib/components/user-settings/SettingsSection.svelte';

	type ScimToken = {
		id: string;
		name: string;
		lastUsedAt: string | null;
		expiresAt: string | null;
		createdAt: string;
	};

	let {
		isOwner,
		scimLoading,
		scimBaseUrl,
		scimTokens = [],
		scimNewName = $bindable(''),
		scimCreating,
		scimRevokingId,
		scimCreatedToken,
		onCreateToken,
		onRevokeToken,
		onDismissCreatedToken,
		index = 0
	}: {
		isOwner: boolean;
		scimLoading: boolean;
		scimBaseUrl: string;
		scimTokens: ScimToken[];
		scimNewName: string;
		scimCreating: boolean;
		scimRevokingId: string | null;
		scimCreatedToken: { name: string; token: string } | null;
		onCreateToken: () => void;
		onRevokeToken: (id: string) => void;
		onDismissCreatedToken: () => void;
		index?: number;
	} = $props();

	let copiedField = $state<string | null>(null);

	async function copy(value: string, field: string) {
		try {
			await navigator.clipboard.writeText(value);
			copiedField = field;
			setTimeout(() => {
				if (copiedField === field) copiedField = null;
			}, 1500);
		} catch {
			/* clipboard unavailable */
		}
	}

	function formatDate(value: string | null): string {
		if (!value) return 'Never';
		return new Date(value).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}
</script>

{#if isOwner}
	<SettingsSection
		title="SCIM Provisioning"
		description="Sync members automatically from your identity provider"
		iconColor="amber"
		{index}
	>
		{#snippet icon(hovered)}<UserCog size={18} animate={hovered} />{/snippet}

		{#if scimLoading}
			<div class="scim-loading">
				<Loader2 class="h-5 w-5 animate-spin" />
			</div>
		{:else}
			<!-- Endpoint -->
			<div class="scim-section">
				<h3 class="scim-section-title">
					<Link2 class="h-3.5 w-3.5" />
					SCIM Endpoint
				</h3>
				<div class="scim-endpoint-row">
					<input type="text" class="input scim-endpoint-input" value={scimBaseUrl} readonly />
					<button class="btn btn-secondary" onclick={() => copy(scimBaseUrl, 'endpoint')}>
						{#if copiedField === 'endpoint'}<Check class="h-4 w-4" />{:else}<Copy
								class="h-4 w-4"
							/>{/if}
						{copiedField === 'endpoint' ? 'Copied' : 'Copy'}
					</button>
				</div>
				<p class="scim-hint">
					Paste this URL and a bearer token below into your identity provider's SCIM 2.0 connector
					(Okta, Entra ID, Google Workspace). Authentication uses OAuth Bearer Token.
				</p>
			</div>

			<!-- Freshly minted token (shown once) -->
			{#if scimCreatedToken}
				<div class="scim-section">
					<div class="scim-reveal">
						<div class="scim-reveal-head">
							<TriangleAlert class="h-4 w-4" />
							<span>Copy this token now — it won't be shown again.</span>
						</div>
						<div class="scim-endpoint-row">
							<input
								type="text"
								class="input scim-endpoint-input scim-token-value"
								value={scimCreatedToken.token}
								readonly
							/>
							<button
								class="btn btn-secondary"
								onclick={() => copy(scimCreatedToken!.token, 'newtoken')}
							>
								{#if copiedField === 'newtoken'}<Check class="h-4 w-4" />{:else}<Copy
										class="h-4 w-4"
									/>{/if}
								{copiedField === 'newtoken' ? 'Copied' : 'Copy'}
							</button>
						</div>
						<button class="scim-reveal-dismiss" onclick={onDismissCreatedToken}>Done</button>
					</div>
				</div>
			{/if}

			<!-- Tokens -->
			<div class="scim-section">
				<h3 class="scim-section-title">
					<KeyRound class="h-3.5 w-3.5" />
					Bearer Tokens
				</h3>

				{#if scimTokens.length === 0}
					<p class="scim-empty">No tokens yet. Generate one to connect your identity provider.</p>
				{:else}
					<div class="scim-token-list">
						{#each scimTokens as token (token.id)}
							<div class="scim-token-item">
								<div class="scim-token-meta">
									<p class="scim-token-name">{token.name}</p>
									<p class="scim-token-sub">
										Created {formatDate(token.createdAt)} · Last used {formatDate(token.lastUsedAt)}
										{#if token.expiresAt}· Expires {formatDate(token.expiresAt)}{/if}
									</p>
								</div>
								<button
									class="scim-token-revoke"
									onclick={() => onRevokeToken(token.id)}
									disabled={scimRevokingId === token.id}
									aria-label="Revoke token"
								>
									{#if scimRevokingId === token.id}
										<Loader2 class="h-4 w-4 animate-spin" />
									{:else}
										<Trash2 class="h-4 w-4" />
									{/if}
								</button>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Create -->
			<div class="scim-section scim-create">
				<div class="scim-field scim-create-field">
					<label class="scim-field-label" for="scim-token-name">New Token Name</label>
					<input
						id="scim-token-name"
						type="text"
						class="input"
						bind:value={scimNewName}
						placeholder="Okta production"
						onkeydown={(e) => {
							if (e.key === 'Enter' && scimNewName.trim()) onCreateToken();
						}}
					/>
				</div>
				<button
					class="btn btn-primary scim-create-btn"
					onclick={onCreateToken}
					disabled={scimCreating || !scimNewName.trim()}
				>
					{#if scimCreating}<Loader2 class="h-4 w-4 animate-spin" />{/if}
					Generate Token
				</button>
			</div>
		{/if}
	</SettingsSection>
{:else}
	<SettingsSection
		title="SCIM Provisioning"
		description="Sync members automatically from your identity provider"
		iconColor="amber"
		{index}
	>
		{#snippet icon(hovered)}<UserCog size={18} animate={hovered} />{/snippet}
		<p class="scim-no-access">Only the organization owner can manage SCIM provisioning.</p>
	</SettingsSection>
{/if}

<style>
	.scim-loading {
		display: flex;
		justify-content: center;
		padding: 2rem;
		color: var(--surface-muted);
	}

	.scim-section {
		padding: 1rem 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		border-top: 1px solid var(--surface-border);
	}

	.scim-section-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.scim-endpoint-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.scim-endpoint-input {
		flex: 1;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.8rem;
	}

	.scim-token-value {
		color: var(--center-channel-color);
	}

	.scim-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0;
		line-height: 1.5;
	}

	.scim-reveal {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		padding: 0.875rem 1rem;
		border-radius: 0.625rem;
		background: color-mix(in srgb, var(--away-indicator) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--away-indicator) 25%, transparent);
	}

	.scim-reveal-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--away-indicator);
	}

	.scim-reveal-dismiss {
		align-self: flex-start;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--surface-muted);
		background: transparent;
		border: none;
		cursor: pointer;
		padding: 0;
	}

	.scim-reveal-dismiss:hover {
		color: var(--center-channel-color);
	}

	.scim-empty {
		font-size: 0.8rem;
		color: var(--surface-muted);
		margin: 0;
	}

	.scim-token-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.scim-token-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem 0.875rem;
		border-radius: 0.625rem;
		border: 1px solid var(--surface-border);
		background: color-mix(in srgb, var(--center-channel-color) 2%, transparent);
	}

	.scim-token-meta {
		min-width: 0;
	}

	.scim-token-name {
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.scim-token-sub {
		font-size: 0.7rem;
		color: var(--surface-muted);
		margin: 0.15rem 0 0;
	}

	.scim-token-revoke {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
		background: transparent;
		border: 1px solid var(--surface-border);
		color: var(--surface-muted);
		cursor: pointer;
		transition:
			color 120ms ease,
			border-color 120ms ease,
			background-color 120ms ease;
	}

	.scim-token-revoke:hover:not(:disabled) {
		color: var(--error-text-color, #ef4444);
		border-color: color-mix(in srgb, var(--error-text-color, #ef4444) 40%, transparent);
		background: color-mix(in srgb, var(--error-text-color, #ef4444) 8%, transparent);
	}

	.scim-token-revoke:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.scim-field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.scim-field-label {
		font-size: 0.75rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
	}

	.scim-create {
		flex-direction: row;
		align-items: flex-end;
		gap: 0.5rem;
	}

	.scim-create-field {
		flex: 1;
	}

	.scim-create-btn {
		flex-shrink: 0;
	}

	.scim-no-access {
		font-size: 0.8rem;
		color: var(--surface-muted);
		margin: 0;
	}

	@media (max-width: 640px) {
		.scim-create {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
