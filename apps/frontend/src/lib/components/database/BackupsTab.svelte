<script lang="ts">
	import { Loader2 } from 'lucide-svelte';
	import type { DatabaseDetail, Backup, SchedulePreset } from './types';

	let {
		database,
		orgSlug,
		backups,
		backupsLoading,
		creatingBackup,
		restoringBackupId,
		schedulePreset = $bindable(),
		scheduleCustomCron = $bindable(),
		scheduleCron,
		scheduleLoaded,
		scheduleSaving,
		maxBackups,
		schedulePresets,
		onCreateBackup,
		onRestoreBackup,
		onSaveSchedule,
		formatBytes,
		formatDate
	}: {
		database: DatabaseDetail;
		orgSlug: string;
		backups: Backup[];
		backupsLoading: boolean;
		creatingBackup: boolean;
		restoringBackupId: string | null;
		schedulePreset: string;
		scheduleCustomCron: string;
		scheduleCron: string;
		scheduleLoaded: boolean;
		scheduleSaving: boolean;
		maxBackups: number;
		schedulePresets: SchedulePreset[];
		onCreateBackup: () => void;
		onRestoreBackup: (backup: Backup) => void;
		onSaveSchedule: () => void;
		formatBytes: (bytes: number | null) => string;
		formatDate: (s: string) => string;
	} = $props();
</script>

<div class="space-y-5">
	{#if database.mode === 'cnpg' && database.backupsEnabled}
		<div class="card rounded-2xl p-5">
			<div class="flex items-center justify-between mb-3">
				<p class="text-sm font-semibold" style="color: var(--center-channel-color);">
					Backup schedule
				</p>
				<button class="btn btn-primary btn-sm" onclick={onSaveSchedule} disabled={scheduleSaving}>
					{#if scheduleSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
					<span>{schedulePreset === 'none' ? 'Clear' : 'Save'}</span>
				</button>
			</div>

			<div class="grid gap-3 md:grid-cols-2">
				<div>
					<p class="text-xs mb-1" style="color: var(--surface-muted);">Run backups</p>
					<select class="input text-sm" bind:value={schedulePreset} disabled={scheduleSaving}>
						<option value="none">Never (manual only)</option>
						{#each schedulePresets as p}
							<option value={p.id}>{p.label}</option>
						{/each}
					</select>
				</div>
				{#if schedulePreset === 'custom'}
					<div>
						<p class="text-xs mb-1" style="color: var(--surface-muted);">Cron expression</p>
						<input
							type="text"
							class="input font-mono text-sm"
							placeholder="0 2 * * *"
							bind:value={scheduleCustomCron}
							disabled={scheduleSaving}
						/>
					</div>
				{/if}
			</div>

			{#if schedulePreset === 'custom'}
				<p class="text-xs mt-2" style="color: var(--surface-muted);">
					5 fields: <code class="db-inline-code">min hour day month weekday</code>. Interpreted in
					UTC.
				</p>
			{:else if schedulePreset !== 'none'}
				{@const active = schedulePresets.find((p) => p.id === schedulePreset)}
				{#if active}
					<p class="text-xs mt-2" style="color: var(--surface-muted);">
						{active.description} · <code class="db-inline-code">{active.cron}</code>
					</p>
				{/if}
			{/if}
			{#if scheduleCron}
				<p class="text-xs mt-1" style="color: var(--surface-muted);">
					Currently active: <code class="db-inline-code">{scheduleCron}</code>
				</p>
			{/if}
		</div>
	{/if}

	<div class="card rounded-2xl p-5">
		<div class="flex items-center justify-between mb-3">
			<div class="flex items-center gap-2">
				<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Backups</p>
				{#if backups.length > 0}
					<span class="db-badge-count"
						>{backups.filter((b) => b.status === 'completed').length} / {maxBackups}</span
					>
				{/if}
			</div>
			{#if (database.mode === 'cnpg' || database.mode === 'container') && database.backupsEnabled}
				<button class="btn btn-primary btn-sm" onclick={onCreateBackup} disabled={creatingBackup}>
					{#if creatingBackup}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
					<span>Create backup</span>
				</button>
			{/if}
		</div>

		{#if database.mode === 'cnpg' && database.backupsEnabled && backups.length > 0}
			<p class="text-xs mb-3" style="color: var(--surface-muted);">
				The oldest completed backup is automatically pruned when you exceed {maxBackups}.
			</p>
		{/if}

		{#if database.mode !== 'cnpg' && database.mode !== 'container'}
			<div class="db-empty-box">
				<p class="text-sm" style="color: var(--surface-muted);">
					Backups require a managed database (CNPG). Recreate this database to enable backups.
				</p>
			</div>
		{:else if !database.backupsEnabled}
			<div class="db-empty-box">
				<p class="text-sm" style="color: var(--surface-muted);">
					Backups are disabled. Configure an R2 bucket in
					<a href={`/${orgSlug}/settings`} class="db-link">organization settings</a>
					to enable pgBackRest backups for this database.
				</p>
			</div>
		{:else if backupsLoading && backups.length === 0}
			<div class="db-empty-box flex items-center gap-2">
				<Loader2 class="h-4 w-4 animate-spin" />
				<span class="text-sm" style="color: var(--surface-muted);">Loading backups…</span>
			</div>
		{:else if backups.length === 0}
			<div class="db-empty-box">
				<p class="text-sm" style="color: var(--surface-muted);">
					No backups yet. Create your first backup to enable point-in-time restores.
				</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each backups as backup (backup.id)}
					<div class="db-list-row">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2 flex-wrap">
								<span class="db-list-name">{backup.label}</span>
								<span class="db-status-pill db-status-pill-{backup.status}">{backup.status}</span>
							</div>
							<div class="db-list-meta">
								<span class="db-list-meta-tag">{backup.type}</span>
								<span>·</span>
								<span>{formatDate(backup.createdAt)}</span>
								{#if backup.sizeBytes}
									<span>·</span>
									<span>{formatBytes(Number(backup.sizeBytes))}</span>
								{/if}
							</div>
							{#if backup.errorMessage}
								<div class="db-list-error">{backup.errorMessage}</div>
							{/if}
						</div>
						{#if backup.status === 'completed'}
							<button
								class="btn btn-secondary btn-sm shrink-0"
								onclick={() => onRestoreBackup(backup)}
								disabled={restoringBackupId === backup.id}
							>
								{#if restoringBackupId === backup.id}<Loader2
										class="h-3.5 w-3.5 animate-spin"
									/>{/if}
								<span>Restore</span>
							</button>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
