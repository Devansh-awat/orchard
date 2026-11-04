<script lang="ts">
	import { onMount } from 'svelte';
	import { Play } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		Badge,
		Button,
		SectionCard,
		SettingRow,
		SettingsList,
		StatusBadge,
		ToggleRow,
		statusMeta
	} from '$lib/components/ui';

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
			if (!res.ok) throw new Error("Couldn't save");
			state = await res.json();
			if (key === 'pluginMigration') {
				const m = await apiFetch('/apiv1/admin/databases/plugin-migration');
				if (m.ok) migration = await m.json();
			}
			const label = ROWS.find((r) => r.key === key)?.label ?? 'Setting';
			toasts.add({ title: `${label} ${next ? 'on' : 'off'}`, color: 'success' });
		} catch (e) {
			if (state) state = { ...state, [key]: { ...state[key] } };
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
			if (!res.ok) throw new Error("Couldn't resume the migration");
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
		<SettingsList>
			{#each ROWS as row (row.key)}
				{@const t = state[row.key]}
				{#if t.envOverride !== null}
					<SettingRow label={row.label}>
						{#snippet hint()}
							Pinned {t.envOverride ? 'on' : 'off'} by <code>{row.env}</code>. Unset it to control
							this here.
						{/snippet}
						<Badge>env override</Badge>
					</SettingRow>
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
					<SettingRow
						label="{migration.migrated} of {migration.migrated +
							migration.remaining} databases moved"
						hint={migration.halted ?? undefined}
					>
						<StatusBadge meta={migrationMeta} variant="plain" />
						{#if migration.halted}
							<Button size="sm" icon={Play} loading={resuming} onclick={resume}>Resume</Button>
						{/if}
					</SettingRow>
				{/if}
			{/each}
		</SettingsList>
	</SectionCard>
{/if}
