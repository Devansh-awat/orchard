<script lang="ts">
	import { Loader2, Pencil, Check, Lock } from 'lucide-svelte';
	import { CloudUpload } from '@jis3r/icons';
	import { Button, Field, Input } from '$lib/components/ui';
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
	title="Database backups (R2)"
	description="Configure Cloudflare R2 for pgBackRest backups"
	{index}
>
	{#snippet icon(hovered)}<CloudUpload size={18} animate={hovered} />{/snippet}

	{#snippet badge()}
		{#if !backupLoading && backupConfigured && !backupEditMode && isOwner}
			<Button variant="ghost" size="sm" onclick={() => (backupEditMode = true)}>
				<Pencil class="h-3.5 w-3.5" />
				Edit
			</Button>
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
				<dt>R2 endpoint</dt>
				<dd class="ob-mono">{backupEndpoint || 'Not set'}</dd>
			</div>
			<div class="ob-readonly-row">
				<dt>Bucket</dt>
				<dd class="ob-mono">{backupBucket || 'Not set'}</dd>
			</div>
			<div class="ob-readonly-row">
				<dt>Region</dt>
				<dd>{backupRegion || 'auto'}</dd>
			</div>
			<div class="ob-readonly-row">
				<dt>Access key ID</dt>
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
						Not set
					{/if}
				</dd>
			</div>
			<div class="ob-readonly-row">
				<dt>Secret access key</dt>
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
			<Field label="R2 endpoint" for="ob-endpoint">
				<Input
					id="ob-endpoint"
					placeholder="https://<account-id>.r2.cloudflarestorage.com"
					bind:value={backupEndpoint}
				/>
			</Field>

			<Field label="Bucket" for="ob-bucket">
				<Input id="ob-bucket" placeholder="orchard-backups" bind:value={backupBucket} />
			</Field>

			<Field label="Region" for="ob-region">
				<Input id="ob-region" placeholder="auto" bind:value={backupRegion} />
			</Field>

			<Field
				label="Access key ID"
				for="ob-access-key"
				hint={backupAccessKeyConfigured
					? `Configured${backupAccessKeyLast4 ? `, ends in ${backupAccessKeyLast4}` : ''}, leave empty to keep`
					: undefined}
			>
				<Input
					id="ob-access-key"
					placeholder={backupAccessKeyConfigured ? '••••••••••••' : 'R2 access key'}
					bind:value={backupAccessKey}
				/>
			</Field>

			<Field
				label="Secret access key"
				for="ob-secret-key"
				hint={backupSecretConfigured ? 'Configured, leave empty to keep' : undefined}
			>
				<Input
					id="ob-secret-key"
					type="password"
					placeholder={backupSecretConfigured ? '••••••••••••' : 'R2 secret key'}
					bind:value={backupSecretKey}
				/>
			</Field>

			<div class="ob-actions">
				<Button variant="primary" onclick={onSaveBackupSettings} loading={backupSaving}>
					Save backup settings
				</Button>
				{#if backupEditMode && backupConfigured}
					<Button variant="ghost" onclick={onCancelEdit} disabled={backupSaving}>Cancel</Button>
				{/if}
				{#if backupSecretConfigured && isOwner}
					<Button variant="ghost" onclick={onClearBackupSettings} disabled={backupSaving}>
						Clear
					</Button>
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
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--surface-muted);
		margin: 0;
	}
	.ob-lock-note {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--surface-muted);
		margin: 0.75rem 0 0;
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
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--surface-muted);
	}
	.ob-readonly-row dd {
		margin: 0;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--center-channel-color);
	}
	.ob-mono {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
	}
	.ob-status-ok {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--online-indicator);
	}

	/* Edit form */
	.ob-form {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}
	.ob-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding-top: 0.25rem;
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
