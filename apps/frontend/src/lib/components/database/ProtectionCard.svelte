<script lang="ts">
	import { apiFetch, toasts } from '$lib/stores';
	import { ActionRow, SectionCard, SettingsList, Switch } from '$lib/components/ui';
	import { errorMessage } from './recovery';
	import type { DatabaseDetail, DatabaseProtection } from './types';

	let {
		database,
		onchanged
	}: {
		database: DatabaseDetail;
		onchanged: (next: DatabaseProtection) => void;
	} = $props();

	type Key = keyof DatabaseProtection;

	const ROWS: { key: Key; label: string; on: string; off: string; needsBackups: boolean }[] = [
		{
			key: 'deletionProtection',
			label: 'Deletion protection',
			on: 'Delete is refused until you turn this off.',
			off: 'Anyone who can manage this database can delete it.',
			needsBackups: false
		},
		{
			key: 'ddlCheckpoints',
			label: 'Checkpoint before drops',
			on: 'A restore point is taken before any DROP TABLE, DROP SCHEMA or DROP COLUMN runs.',
			off: 'Drops run without a restore point right before them.',
			needsBackups: true
		},
		{
			key: 'restoreTests',
			label: 'Weekly restore tests',
			on: 'Every week the latest backup is restored into a throwaway copy and checked.',
			off: 'Backups are only checked when you run a test.',
			needsBackups: true
		}
	];

	const NO_BACKUPS = 'Needs backup storage, which this organization does not have yet.';
	const unavailable = (row: (typeof ROWS)[number]) =>
		row.needsBackups && database.backupsEnabled === false;

	let saving = $state<Key | null>(null);
	let pending = $state<Partial<DatabaseProtection>>({});

	const value = (key: Key) => pending[key] ?? !!database[key];

	async function set(key: Key, on: boolean) {
		saving = key;
		pending = { ...pending, [key]: on };
		try {
			const res = await apiFetch(`/apiv1/databases/${database.id}/protection`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ [key]: on })
			});
			if (!res.ok) throw new Error(await errorMessage(res, 'Could not save'));
			const next = (await res.json()) as DatabaseProtection;
			onchanged({
				deletionProtection: next.deletionProtection,
				ddlCheckpoints: next.ddlCheckpoints,
				restoreTests: next.restoreTests
			});
		} catch (e) {
			toasts.add({
				title: 'Could not save',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			const rest = { ...pending };
			delete rest[key];
			pending = rest;
			saving = null;
		}
	}
</script>

<SectionCard title="Protection">
	<SettingsList>
		{#each ROWS as row (row.key)}
			<ActionRow
				label={row.label}
				hint={unavailable(row) ? NO_BACKUPS : value(row.key) ? row.on : row.off}
			>
				<Switch
					label={row.label}
					checked={value(row.key) && !unavailable(row)}
					disabled={saving === row.key || database.mode !== 'cnpg' || unavailable(row)}
					onchange={(on) => set(row.key, on)}
				/>
			</ActionRow>
		{/each}
	</SettingsList>
</SectionCard>
