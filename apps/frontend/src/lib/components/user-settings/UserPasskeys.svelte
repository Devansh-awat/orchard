<script lang="ts">
	import { Loader2, Fingerprint } from 'lucide-svelte';
	import { KeyRound, Pencil, Trash2, Check, X, Plus } from '@jis3r/icons';
	import SettingsSection from './SettingsSection.svelte';
	import IconButton from './IconButton.svelte';

	interface PasskeyRecord {
		id: string;
		friendlyName?: string | null;
		createdAt: string;
		lastUsedAt?: string | null;
		deviceType?: string | null;
		backedUp?: boolean;
		transports?: string[];
	}

	let {
		passkeys,
		passkeysLoading,
		passkeyListError,
		passkeyEnvWarning,
		registerLoading,
		showAddPasskey = $bindable(false),
		newPasskeyName = $bindable(''),
		editingPasskeyId = $bindable<string | null>(null),
		renameValue = $bindable(''),
		renaming,
		deletingPasskeyId,
		onRegister,
		onStartRenaming,
		onCancelRenaming,
		onSavePasskeyName,
		onConfirmDelete,
		formatTimestamp,
		index = 0
	}: {
		passkeys: PasskeyRecord[];
		passkeysLoading: boolean;
		passkeyListError: string | null;
		passkeyEnvWarning: string | null;
		registerLoading: boolean;
		showAddPasskey: boolean;
		newPasskeyName: string;
		editingPasskeyId: string | null;
		renameValue: string;
		renaming: boolean;
		deletingPasskeyId: string | null;
		onRegister: () => void;
		onStartRenaming: (passkey: PasskeyRecord) => void;
		onCancelRenaming: () => void;
		onSavePasskeyName: () => void;
		onConfirmDelete: (passkey: PasskeyRecord) => void;
		formatTimestamp: (value?: string | null) => string;
		index?: number;
	} = $props();

	let addBtnHovered = $state(false);
</script>

<SettingsSection
	{index}
	title="Passkeys"
	description="Sign in with Touch ID, Face ID, or Windows Hello"
	iconColor="primary"
>
	{#snippet icon(hovered)}<KeyRound size={18} animate={hovered} />{/snippet}
	{#snippet badge()}
		{#if !passkeysLoading && passkeys.length > 0}
			<span class="pk-count">{passkeys.length}</span>
		{/if}
	{/snippet}

	{#if passkeyEnvWarning}
		<div class="pk-warning">{passkeyEnvWarning}</div>
	{/if}

	{#if passkeyListError}
		<div class="pk-error">{passkeyListError}</div>
	{/if}

	{#if passkeysLoading}
		<div class="pk-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
	{:else}
		{#if passkeys.length > 0}
			<div class="pk-list">
				{#each passkeys as passkey}
					<div class="pk-item">
						<div class="pk-dot"></div>
						<div class="pk-body">
							{#if editingPasskeyId === passkey.id}
								<div class="pk-edit-row">
									<input
										class="pk-input"
										type="text"
										placeholder="Friendly name"
										bind:value={renameValue}
									/>
									<IconButton variant="save" onclick={onSavePasskeyName} disabled={renaming}>
										{#snippet children(hovered)}{#if renaming}<Loader2
													class="h-3 w-3 animate-spin"
												/>{:else}<Check size={13} animate={hovered} />{/if}{/snippet}
									</IconButton>
									<IconButton onclick={onCancelRenaming}>
										{#snippet children(hovered)}<X size={13} animate={hovered} />{/snippet}
									</IconButton>
								</div>
							{:else}
								<span class="pk-name">{passkey.friendlyName || 'Passkey'}</span>
								<span class="pk-meta">
									Last used {formatTimestamp(passkey.lastUsedAt)} · Added {formatTimestamp(
										passkey.createdAt
									)}
								</span>
							{/if}
						</div>
						{#if editingPasskeyId !== passkey.id}
							<div class="pk-actions">
								<IconButton onclick={() => onStartRenaming(passkey)} title="Rename">
									{#snippet children(hovered)}<Pencil size={13} animate={hovered} />{/snippet}
								</IconButton>
								<IconButton
									variant="danger"
									onclick={() => onConfirmDelete(passkey)}
									disabled={deletingPasskeyId === passkey.id}
									title="Remove"
								>
									{#snippet children(hovered)}{#if deletingPasskeyId === passkey.id}<Loader2
												class="h-3 w-3 animate-spin"
											/>{:else}<Trash2 size={13} animate={hovered} />{/if}{/snippet}
								</IconButton>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{:else}
			<p class="pk-empty">No passkeys yet. Add one to skip email codes when signing in.</p>
		{/if}

		{#if showAddPasskey}
			<div class="pk-add-row">
				<input
					class="pk-input pk-input--full"
					type="text"
					placeholder="Device name (optional)"
					bind:value={newPasskeyName}
				/>
				<button
					class="pk-btn pk-btn--solid"
					type="button"
					onclick={onRegister}
					disabled={registerLoading}
				>
					{#if registerLoading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
					Register
				</button>
				<button
					class="pk-btn pk-btn--ghost"
					type="button"
					onclick={() => {
						showAddPasskey = false;
						newPasskeyName = '';
					}}>Cancel</button
				>
			</div>
		{:else}
			<button
				class="pk-add-btn"
				onclick={() => (showAddPasskey = true)}
				onmouseenter={() => (addBtnHovered = true)}
				onmouseleave={() => (addBtnHovered = false)}
			>
				<Plus size={14} animate={addBtnHovered} />
				Add passkey
			</button>
		{/if}
	{/if}
</SettingsSection>

<style>
	.pk-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.375rem;
		border-radius: 2rem;
		font-size: 0.6875rem;
		font-weight: 650;
		background-color: color-mix(in srgb, var(--button-bg) 10%, transparent);
		color: var(--button-bg);
	}
	.pk-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem 0;
		color: var(--surface-muted);
	}
	.pk-warning {
		padding: 0.625rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		background-color: color-mix(in srgb, var(--warning-text) 8%, transparent);
		color: var(--warning-text);
		border: 1px solid color-mix(in srgb, var(--warning-text) 20%, transparent);
	}
	.pk-error {
		padding: 0.625rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		background-color: color-mix(in srgb, var(--error-text-color) 8%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 20%, transparent);
	}
	.pk-list {
		display: flex;
		flex-direction: column;
	}
	.pk-item {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.875rem 0;
	}
	.pk-item + .pk-item {
		border-top: 1px solid color-mix(in srgb, var(--surface-border) 40%, transparent);
	}
	.pk-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background-color: var(--button-bg);
		flex-shrink: 0;
		margin-top: 0.4375rem;
		opacity: 0.6;
	}
	.pk-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.pk-name {
		font-size: 0.875rem;
		font-weight: 550;
		color: var(--center-channel-color);
	}
	.pk-meta {
		font-size: 0.6875rem;
		color: var(--surface-muted);
	}
	.pk-edit-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.pk-actions {
		display: flex;
		gap: 0.125rem;
		flex-shrink: 0;
		margin-top: 0.125rem;
	}
	.pk-input {
		padding: 0.3125rem 0.5rem;
		font-size: 0.8125rem;
		border: 1px solid var(--sidebar-text-active-border);
		border-radius: 0.375rem;
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
		line-height: 1.5;
	}
	.pk-input:focus {
		outline: none;
	}
	.pk-input--full {
		width: 100%;
		min-width: 0;
		flex: 1;
	}
	.pk-add-row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	.pk-add-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		font-weight: 550;
		color: var(--button-bg);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0.25rem 0;
		transition: opacity 120ms;
	}
	.pk-add-btn:hover {
		opacity: 0.75;
	}
	.pk-empty {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		padding: 0.5rem 0;
		margin: 0;
	}
	.pk-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 550;
		border: none;
		cursor: pointer;
		transition: all 120ms;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.pk-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.pk-btn--solid {
		background-color: var(--button-bg);
		color: var(--button-color);
	}
	.pk-btn--solid:hover:not(:disabled) {
		opacity: 0.9;
	}
	.pk-btn--ghost {
		background: none;
		color: var(--surface-muted);
	}
	.pk-btn--ghost:hover:not(:disabled) {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--center-channel-color) 5%, transparent);
	}
	@media (max-width: 640px) {
		.pk-add-row {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
