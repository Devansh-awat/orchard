<script lang="ts">
	import { onMount } from 'svelte';
	import { Play } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { Badge, Button, SectionCard, StatusDot, ToggleRow, statusMeta } from '$lib/components/ui';

	type Key = 'ddlCheckpoints' | 'restoreDrills' | 'pluginMigration' | 'poolerByDefault';

	interface Toggle {
		enabled: boolean;
		dbValue: boolean;
		envOverride: boolean | null;
		unavailable?: string;
	}

	interface Migration {
		enabled: boolean;
		pluginInstalled: boolean;
		halted: string | null;
		migrated: number;
		remaining: number;
	}

	const ROWS: { key: Key; label: string; hint: string; env: string }[] = [
		{
			key: 'ddlCheckpoints',
			label: 'Checkpoint before drops',
			hint: 'Every database takes a restore point before any DROP runs. Each database can opt out.',
			env: 'DB_DDL_CHECKPOINTS'
		},
		{
			key: 'restoreDrills',
			label: 'Weekly restore tests',
			hint: 'Every database with backups is restored into a throwaway copy once a week and checked.',
			env: 'DB_RESTORE_DRILLS'
		},
		{
			key: 'pluginMigration',
			label: 'Move backups to the Barman Cloud plugin',
			hint: 'Moves a few databases every 10 minutes, keeps their old backups restorable, and stops if one stops archiving.',
			env: 'CNPG_BARMAN_PLUGIN_MIGRATE'
		},
		{
			key: 'poolerByDefault',
			label: 'Connection pooler for new small databases',
			hint: 'New databases with 1 GB of memory or less start with a connection pooler.',
			env: 'DB_POOLER_BY_DEFAULT'
		}
	];

	let state = $state<Record<Key, Toggle> | null>(null);
	let migration = $state<Migration | null>(null);
	let saving = $state<Key | null>(null);
	let resuming = $state(false);

	async function load() {
		try {
			const [s, m] = await Promise.all([
				apiFetch('/apiv1/admin/instance-settings/databases'),
				apiFetch('/apiv1/admin/databases/plugin-migration')
			]);
			if (s.ok) state = await s.json();
			if (m.ok) migration = await m.json();
		} catch {
			state = state ?? null;
		}
	}

	async function toggle(key: Key) {
		if (!state || state[key].envOverride !== null) return;
		saving = key;
		const next = !state[key].dbValue;
		try {
			const res = await apiFetch('/apiv1/admin/instance-settings/databases', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ toggle: key, enabled: next })
			});
			if (!res.ok) throw new Error('Failed to save');
			state = await res.json();
			if (key === 'pluginMigration') {
				const m = await apiFetch('/apiv1/admin/databases/plugin-migration');
				if (m.ok) migration = await m.json();
			}
			const label = ROWS.find((r) => r.key === key)?.label ?? 'Setting';
			toasts.add({ title: `${label} ${next ? 'on' : 'off'}`, color: 'success' });
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			saving = null;
		}
	}

	async function resume() {
		resuming = true;
		try {
			const res = await apiFetch('/apiv1/admin/databases/plugin-migration/resume', {
				method: 'POST'
			});
			if (!res.ok) throw new Error('Could not resume the migration');
			migration = await res.json();
			toasts.add({ title: 'Migration resumed', color: 'success' });
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			resuming = false;
		}
	}

	const migrationMeta = $derived.by(() => {
		if (!migration) return null;
		if (!migration.pluginInstalled) return statusMeta('warning', 'Plugin not installed');
		if (migration.halted) return statusMeta('error', 'Halted');
		if (migration.remaining === 0) return statusMeta('success', 'Done');
		if (!migration.enabled) return statusMeta('neutral', 'Off');
		return statusMeta('progress', 'Moving', true);
	});

	onMount(load);
</script>

{#if state}
	<SectionCard title="Databases">
		<div class="rows">
			{#each ROWS as row (row.key)}
				{@const t = state[row.key]}
				{#if t.envOverride !== null}
					<div class="locked">
						<div class="locked-text">
							<span class="label">{row.label}</span>
							<span class="hint">
								Pinned {t.envOverride ? 'on' : 'off'} by <span class="mono">{row.env}</span>. Unset
								it to control this here.
							</span>
						</div>
						<Badge tone="neutral">env override</Badge>
					</div>
				{:else}
					<ToggleRow
						checked={t.dbValue && !t.unavailable}
						label={row.label}
						hint={t.unavailable ?? row.hint}
						disabled={saving === row.key || !!t.unavailable}
						onchange={() => toggle(row.key)}
					/>
				{/if}
				{#if row.key === 'pluginMigration' && migration && migrationMeta}
					<div class="migration">
						<StatusDot meta={migrationMeta} label={migrationMeta.label} />
						<div class="migration-text">
							<span class:bad={migrationMeta.kind === 'error'}>
								{migrationMeta.label} · {migration.migrated} of {migration.migrated +
									migration.remaining} moved
							</span>
							{#if migration.halted}
								<span class="reason" title={migration.halted}>{migration.halted}</span>
							{/if}
						</div>
						{#if migration.halted}
							<Button size="sm" icon={Play} loading={resuming} onclick={resume}>Resume</Button>
						{/if}
					</div>
				{/if}
			{/each}
		</div>
	</SectionCard>
{/if}

<style>
	.rows {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}
	.locked {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.locked-text,
	.migration-text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}
	.label {
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
	.hint {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.mono {
		font-family: var(--font-mono);
	}
	.migration {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.625rem 0.75rem;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-sunken);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-default);
		font-variant-numeric: tabular-nums;
	}
	.migration-text {
		flex: 1;
	}
	.bad {
		font-weight: var(--weight-semibold);
		color: var(--status-error);
	}
	.reason {
		overflow-x: clip;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		color: var(--text-muted);
	}
</style>
