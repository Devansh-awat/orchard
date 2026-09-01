<script lang="ts">
	import { Loader2, Fingerprint } from 'lucide-svelte';
	import { KeyRound, Pencil, Trash2, Check, X, Plus } from '@jis3r/icons';
	import { iconAnimation } from '$lib/utils/motion.svelte';
	import { Alert, Button, EmptyState, Skeleton } from '$lib/components/ui';
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
>
	{#snippet icon(hovered)}<KeyRound size={18} animate={hovered} />{/snippet}
	{#snippet badge()}
		{#if !passkeysLoading && passkeys.length > 0}
			<span class="pk-count">{passkeys.length}</span>
		{/if}
	{/snippet}

	{#if passkeyEnvWarning}
		<div class="pk-alert"><Alert tone="warning">{passkeyEnvWarning}</Alert></div>
	{/if}

	{#if passkeyListError}
		<div class="pk-alert"><Alert tone="error">{passkeyListError}</Alert></div>
	{/if}

	{#if passkeysLoading}
		<div class="pk-loading">
			{#each [0, 1] as row (row)}
				<div class="pk-loading-row">
					<div class="pk-loading-dot">
						<Skeleton width="0.5rem" height="0.5rem" rounded="var(--radius-pill)" />
					</div>
					<div class="pk-loading-lines">
						<Skeleton width="7.5rem" height="0.875rem" rounded="var(--radius-xs)" />
						<Skeleton width="12rem" height="0.6875rem" rounded="var(--radius-xs)" />
					</div>
				</div>
			{/each}
		</div>
	{:else}
		{#if passkeys.length > 0}
			<div class="pk-list">
				{#each passkeys as passkey (passkey.id)}
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
		{:else if !showAddPasskey}
			<EmptyState
				title="No passkeys yet"
				description="Add one to skip email codes when signing in."
			>
				{#snippet icon()}<Fingerprint size={22} />{/snippet}
				<button
					class="pk-add-btn"
					onclick={() => (showAddPasskey = true)}
					onmouseenter={() => (addBtnHovered = true)}
					onmouseleave={() => (addBtnHovered = false)}
				>
					<Plus size={14} animate={iconAnimation(addBtnHovered)} />
					Add passkey
				</button>
			</EmptyState>
		{/if}

		{#if showAddPasskey}
			<div class="pk-add-row">
				<input
					class="pk-input pk-input--full"
					type="text"
					placeholder="Device name (optional)"
					bind:value={newPasskeyName}
				/>
				<Button variant="primary" size="sm" onclick={onRegister} loading={registerLoading}>
					Register
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onclick={() => {
						showAddPasskey = false;
						newPasskeyName = '';
					}}>Cancel</Button
				>
			</div>
		{:else if passkeys.length > 0}
			<button
				class="pk-add-btn"
				onclick={() => (showAddPasskey = true)}
				onmouseenter={() => (addBtnHovered = true)}
				onmouseleave={() => (addBtnHovered = false)}
			>
				<Plus size={14} animate={iconAnimation(addBtnHovered)} />
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
		padding: 0 0.5rem;
		border-radius: var(--radius-pill);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		background-color: var(--accent-subtle);
		color: var(--accent);
	}
	.pk-alert {
		margin-bottom: var(--space-3);
	}
	.pk-loading {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-3) 0;
	}
	.pk-loading-row {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
	}
	.pk-loading-dot {
		flex-shrink: 0;
		margin-top: 0.5rem;
	}
	.pk-loading-lines {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.pk-list {
		display: flex;
		flex-direction: column;
	}
	.pk-item {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: 0.875rem 0;
	}
	.pk-item + .pk-item {
		border-top: 1px solid var(--rule);
	}
	.pk-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: var(--radius-pill);
		background-color: var(--accent);
		flex-shrink: 0;
		margin-top: 0.5rem;
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
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: 600;
		color: var(--text-default);
	}
	.pk-meta {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-muted);
	}
	.pk-edit-row {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}
	.pk-actions {
		display: flex;
		gap: 0.125rem;
		flex-shrink: 0;
		margin-top: 0.125rem;
	}
	.pk-input {
		padding: 0.3125rem var(--space-2);
		font-size: var(--text-callout);
		border: 1px solid var(--accent);
		border-radius: var(--radius-xs);
		background-color: var(--bg-surface);
		color: var(--text-default);
		box-shadow: 0 0 0 2px var(--accent-subtle);
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
		gap: var(--space-2);
		align-items: center;
	}
	.pk-add-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--accent);
		background: none;
		border: none;
		cursor: pointer;
		padding: var(--space-1) 0;
		transition: opacity var(--dur-fast);
	}
	.pk-add-btn:hover {
		opacity: 0.75;
	}
	.pk-add-row :global(.btn) {
		flex-shrink: 0;
	}
	@media (max-width: 640px) {
		.pk-add-row {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
