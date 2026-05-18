<script lang="ts">
	import { Loader2, Pencil, Check, Lock } from 'lucide-svelte';

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
	} = $props();
</script>

<h1 class="os-tab-title">Backups</h1>

{#if canEditOrg}
	<div class="os-card">
		<div class="os-card-header">
			<h2 class="os-card-title">Database Backups (R2)</h2>
			{#if !backupLoading && backupConfigured && !backupEditMode && isOwner}
				<button onclick={() => (backupEditMode = true)} class="btn btn-ghost btn-sm">
					<Pencil class="h-3.5 w-3.5" />
					Edit
				</button>
			{/if}
		</div>

		<div class="os-card-body">
			<p class="os-sso-hint" style="margin-bottom: 1rem;">
				Configure a Cloudflare R2 bucket to enable pgBackRest backups and restores for databases in this organization.
			</p>
		</div>

		{#if backupLoading}
			<div class="os-sso-loading"><Loader2 class="h-5 w-5 animate-spin" /></div>
		{:else if !backupConfigured && !isOwner}
			<div class="os-sso-section">
				<p class="backup-readonly-note">
					<Lock class="h-3.5 w-3.5" />
					Backups are not configured. Only the organization owner can set them up.
				</p>
			</div>
		{:else if backupConfigured && !backupEditMode}
			<div class="os-sso-section">
				<dl class="backup-readonly">
					<div class="backup-readonly-row">
						<dt>R2 Endpoint</dt>
						<dd class="backup-mono">{backupEndpoint || '—'}</dd>
					</div>
					<div class="backup-readonly-row">
						<dt>Bucket</dt>
						<dd class="backup-mono">{backupBucket || '—'}</dd>
					</div>
					<div class="backup-readonly-row">
						<dt>Region</dt>
						<dd>{backupRegion || 'auto'}</dd>
					</div>
					<div class="backup-readonly-row">
						<dt>Access Key ID</dt>
						<dd class="backup-mono">
							{#if backupAccessKeyConfigured}
								{#if backupAccessKeyLast4}
									••••••••{backupAccessKeyLast4}
								{:else}
									<span class="backup-status backup-status-ok">
										<Check class="h-3 w-3" />
										Configured
									</span>
								{/if}
							{:else}
								—
							{/if}
						</dd>
					</div>
					<div class="backup-readonly-row">
						<dt>Secret Access Key</dt>
						<dd>
							<span class="backup-status backup-status-ok">
								<Check class="h-3 w-3" />
								Configured
							</span>
						</dd>
					</div>
				</dl>
				{#if !isOwner}
					<p class="backup-readonly-note">
						<Lock class="h-3.5 w-3.5" />
						Only the organization owner can reveal or change these credentials.
					</p>
				{/if}
			</div>
		{:else}
			<div class="os-sso-section">
				<h3 class="os-sso-section-title">R2 Endpoint</h3>
				<input
					type="text"
					class="input"
					placeholder="https://<account-id>.r2.cloudflarestorage.com"
					bind:value={backupEndpoint}
				/>
			</div>

			<div class="os-sso-section">
				<h3 class="os-sso-section-title">Bucket</h3>
				<input
					type="text"
					class="input"
					placeholder="orchard-backups"
					bind:value={backupBucket}
				/>
			</div>

			<div class="os-sso-section">
				<h3 class="os-sso-section-title">Region</h3>
				<input
					type="text"
					class="input"
					placeholder="auto"
					bind:value={backupRegion}
				/>
			</div>

			<div class="os-sso-section">
				<h3 class="os-sso-section-title">
					Access Key ID
					{#if backupAccessKeyConfigured}
						<span class="os-sso-hint" style="font-weight: 400; margin-left: 0.5rem;">
							(configured{#if backupAccessKeyLast4} · ends in {backupAccessKeyLast4}{/if} · leave empty to keep)
						</span>
					{/if}
				</h3>
				<input
					type="text"
					class="input"
					placeholder={backupAccessKeyConfigured ? '••••••••••••' : 'R2 access key'}
					bind:value={backupAccessKey}
				/>
			</div>

			<div class="os-sso-section">
				<h3 class="os-sso-section-title">
					Secret Access Key
					{#if backupSecretConfigured}
						<span class="os-sso-hint" style="font-weight: 400; margin-left: 0.5rem;">(configured · leave empty to keep)</span>
					{/if}
				</h3>
				<input
					type="password"
					class="input"
					placeholder={backupSecretConfigured ? '••••••••••••' : 'R2 secret key'}
					bind:value={backupSecretKey}
				/>
			</div>

			<div class="os-sso-section" style="display: flex; gap: 0.5rem;">
				<button onclick={onSaveBackupSettings} disabled={backupSaving} class="btn btn-primary">
					{#if backupSaving}<Loader2 class="h-4 w-4 animate-spin" />{/if}
					Save backup settings
				</button>
				{#if backupEditMode && backupConfigured}
					<button onclick={onCancelEdit} disabled={backupSaving} class="btn btn-secondary">
						Cancel
					</button>
				{/if}
				{#if backupSecretConfigured && isOwner}
					<button onclick={onClearBackupSettings} disabled={backupSaving} class="btn btn-secondary">
						Clear
					</button>
				{/if}
			</div>
		{/if}
	</div>
{:else}
	<div class="os-card">
		<div class="os-card-body">
			<p class="text-sm" style="color: var(--surface-muted);">Only admins and owners can manage backup settings.</p>
		</div>
	</div>
{/if}
