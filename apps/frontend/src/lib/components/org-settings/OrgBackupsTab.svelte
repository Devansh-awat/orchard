<script lang="ts">
	import { Loader2, Pencil, Check, Lock } from 'lucide-svelte';
	import { CloudUpload } from '@jis3r/icons';
	import SettingsSection from '$lib/components/user-settings/SettingsSection.svelte';

	let {
		canEditOrg,
		isOwner,
		backupLoading,
		backupSaving,
		backupConfigured,
		backupEditMode = $bindable(false),
		backupEndpoint = $bindable(''),
		backupBucket = $bindable(''),
		backupRegion = $bindable('auto'),
		backupAccessKey = $bindable(''),
		backupSecretKey = $bindable(''),
		backupAccessKeyConfigured,
		backupAccessKeyLast4,
		backupSecretConfigured,
		onSaveBackupSettings,
		onClearBackupSettings,
		onCancelEdit,
		index = 0
	}: {
		canEditOrg: boolean;
		isOwner: boolean;
		backupLoading: boolean;
		backupSaving: boolean;
		backupConfigured: boolean;
		backupEditMode: boolean;
		backupEndpoint: string;
		backupBucket: string;
		backupRegion: string;
		backupAccessKey: string;
		backupSecretKey: string;
		backupAccessKeyConfigured: boolean;
		backupAccessKeyLast4: string | null;
		backupSecretConfigured: boolean;
		onSaveBackupSettings: () => void;
		onClearBackupSettings: () => void;
		onCancelEdit: () => void;
		index?: number;
	} = $props();
</script>

<SettingsSection
	title="Database Backups (R2)"
	description="Configure Cloudflare R2 for pgBackRest backups"
	iconColor="amber"
	{index}
>
	{#snippet icon(hovered)}<CloudUpload size={18} animate={hovered} />{/snippet}

	{#snippet badge()}
		{#if !backupLoading && backupConfigured && !backupEditMode && isOwner}
			<button onclick={() => (backupEditMode = true)} class="ob-edit-btn">
				<Pencil class="h-3.5 w-3.5" />
				Edit
			</button>
		{/if}
	{/snippet}

	{#if !canEditOrg}
		<p class="ob-no-access">Only admins and owners can manage backup settings.</p>
	{:else if backupLoading}
		<div class="ob-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
	{:else if !backupConfigured && !isOwner}
		<p class="ob-lock-note">
			<Lock class="h-3.5 w-3.5" />
			Backups are not configured. Only the organization owner can set them up.
		</p>
	{:else if backupConfigured && !backupEditMode}
		<dl class="ob-readonly">
			<div class="ob-readonly-row">
				<dt>R2 Endpoint</dt>
				<dd class="ob-mono">{backupEndpoint || '—'}</dd>
			</div>
			<div class="ob-readonly-row">
				<dt>Bucket</dt>
				<dd class="ob-mono">{backupBucket || '—'}</dd>
			</div>
			<div class="ob-readonly-row">
				<dt>Region</dt>
				<dd>{backupRegion || 'auto'}</dd>
			</div>
			<div class="ob-readonly-row">
				<dt>Access Key ID</dt>
				<dd class="ob-mono">
					{#if backupAccessKeyConfigured}
						{#if backupAccessKeyLast4}
							••••••••{backupAccessKeyLast4}
						{:else}
							<span class="ob-status-ok">
								<Check class="h-3 w-3" />
								Configured
							</span>
						{/if}
					{:else}
						—
					{/if}
				</dd>
			</div>
			<div class="ob-readonly-row">
				<dt>Secret Access Key</dt>
				<dd>
					<span class="ob-status-ok">
						<Check class="h-3 w-3" />
						Configured
					</span>
				</dd>
			</div>
		</dl>
		{#if !isOwner}
			<p class="ob-lock-note">
				<Lock class="h-3.5 w-3.5" />
				Only the organization owner can reveal or change these credentials.
			</p>
		{/if}
	{:else}
		<div class="ob-form">
			<div class="ob-field">
				<label class="ob-field-label" for="ob-endpoint">R2 Endpoint</label>
				<input
					id="ob-endpoint"
					type="text"
					class="ob-input"
					placeholder="https://<account-id>.r2.cloudflarestorage.com"
					bind:value={backupEndpoint}
				/>
			</div>

			<div class="ob-field">
				<label class="ob-field-label" for="ob-bucket">Bucket</label>
				<input
					id="ob-bucket"
					type="text"
					class="ob-input"
					placeholder="orchard-backups"
					bind:value={backupBucket}
				/>
			</div>

			<div class="ob-field">
				<label class="ob-field-label" for="ob-region">Region</label>
				<input
					id="ob-region"
					type="text"
					class="ob-input"
					placeholder="auto"
					bind:value={backupRegion}
				/>
			</div>

			<div class="ob-field">
				<label class="ob-field-label" for="ob-access-key">
					Access Key ID
					{#if backupAccessKeyConfigured}
						<span class="ob-field-hint">
							(configured{#if backupAccessKeyLast4}
								· ends in {backupAccessKeyLast4}{/if} · leave empty to keep)
						</span>
					{/if}
				</label>
				<input
					id="ob-access-key"
					type="text"
					class="ob-input"
					placeholder={backupAccessKeyConfigured ? '••••••••••••' : 'R2 access key'}
					bind:value={backupAccessKey}
				/>
			</div>

			<div class="ob-field">
				<label class="ob-field-label" for="ob-secret-key">
					Secret Access Key
					{#if backupSecretConfigured}
						<span class="ob-field-hint">(configured · leave empty to keep)</span>
					{/if}
				</label>
				<input
					id="ob-secret-key"
					type="password"
					class="ob-input"
					placeholder={backupSecretConfigured ? '••••••••••••' : 'R2 secret key'}
					bind:value={backupSecretKey}
				/>
			</div>

			<div class="ob-actions">
				<button onclick={onSaveBackupSettings} disabled={backupSaving} class="ob-btn ob-btn--solid">
					{#if backupSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
					Save backup settings
				</button>
				{#if backupEditMode && backupConfigured}
					<button onclick={onCancelEdit} disabled={backupSaving} class="ob-btn ob-btn--ghost">
						Cancel
					</button>
				{/if}
				{#if backupSecretConfigured && isOwner}
					<button
						onclick={onClearBackupSettings}
						disabled={backupSaving}
						class="ob-btn ob-btn--ghost"
					>
						Clear
					</button>
				{/if}
			</div>
		</div>
	{/if}
</SettingsSection>

<style>
	.ob-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem 0;
		color: var(--surface-muted);
	}
	.ob-no-access {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0;
	}
	.ob-lock-note {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0.75rem 0 0;
	}
	.ob-edit-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.625rem;
		border-radius: 0.375rem;
		font-size: 0.75rem;
		font-weight: 550;
		border: none;
		cursor: pointer;
		background: none;
		color: var(--surface-muted);
		transition: all 120ms;
	}
	.ob-edit-btn:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--center-channel-color) 5%, transparent);
	}

	/* Readonly display */
	.ob-readonly {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0;
	}
	.ob-readonly-row {
		display: flex;
		align-items: baseline;
		padding: 0.5rem 0;
		border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 50%, transparent);
	}
	.ob-readonly-row:last-child {
		border-bottom: none;
	}
	.ob-readonly-row dt {
		width: 10rem;
		flex-shrink: 0;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--surface-muted);
	}
	.ob-readonly-row dd {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--center-channel-color);
	}
	.ob-mono {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.75rem;
	}
	.ob-status-ok {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.75rem;
		color: var(--online-indicator);
	}

	/* Edit form */
	.ob-form {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}
	.ob-field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.ob-field-label {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}
	.ob-field-hint {
		font-weight: 400;
		color: var(--surface-muted);
		margin-left: 0.375rem;
	}
	.ob-input {
		padding: 0.4375rem 0.75rem;
		font-size: 0.8125rem;
		border: 1px solid var(--surface-border);
		border-radius: 0.5rem;
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		transition: border-color 150ms;
	}
	.ob-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
	}
	.ob-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding-top: 0.25rem;
	}
	.ob-btn {
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
	}
	.ob-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.ob-btn--solid {
		background-color: var(--button-bg);
		color: var(--button-color);
	}
	.ob-btn--solid:hover:not(:disabled) {
		opacity: 0.9;
	}
	.ob-btn--ghost {
		background: none;
		color: var(--surface-muted);
	}
	.ob-btn--ghost:hover:not(:disabled) {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--center-channel-color) 5%, transparent);
	}

	@media (max-width: 640px) {
		.ob-readonly-row {
			flex-direction: column;
			gap: 0.125rem;
		}
		.ob-readonly-row dt {
			width: auto;
		}
	}
</style>
