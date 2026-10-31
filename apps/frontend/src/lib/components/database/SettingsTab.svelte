<script lang="ts">
	import {
		Alert,
		Button,
		EmptyState,
		FormActions,
		SectionCard,
		SectionTitle,
		Skeleton
	} from '$lib/components/ui';
	import SettingsList from '$lib/components/ui/SettingsList.svelte';
	import { presence } from '$lib/utils/transitions';
	import ParamRow from './ParamRow.svelte';
	import type { DatabaseDetail, ParamMeta } from './types';

	let {
		database,
		paramSchema,
		settingsLoading,
		settingsLoaded,
		settingsSaving,
		settingsDirty,
		settingsAdvisories = [],
		settingsDrift = {},
		savedValues = undefined,
		onFetchSettings,
		onSaveSettings,
		onDiscardSettings = undefined,
		paramValue,
		setParam
	}: {
		database: DatabaseDetail;
		paramSchema: ParamMeta[];
		settingsLoading: boolean;
		settingsLoaded: boolean;
		settingsSaving: boolean;
		settingsDirty: boolean;
		settingsAdvisories?: { key: string; message: string }[];
		settingsDrift?: Record<string, string | null>;
		savedValues?: Record<string, string>;
		onFetchSettings: () => void;
		onSaveSettings: () => void;
		onDiscardSettings?: () => void;
		paramValue: (key: string) => string;
		setParam: (key: string, v: string) => void;
	} = $props();

	const GROUPS = [
		{
			title: 'Connections & memory',
			keys: [
				'max_connections',
				'shared_buffers',
				'work_mem',
				'maintenance_work_mem',
				'effective_cache_size'
			]
		},
		{
			title: 'Timeouts & logging',
			keys: [
				'statement_timeout',
				'idle_in_transaction_session_timeout',
				'log_min_duration_statement'
			]
		},
		{ title: 'Durability', keys: ['synchronous_commit'] }
	];

	const groups = $derived.by(() => {
		const byKey = new Map(paramSchema.map((p) => [p.key, p]));
		const placed = new Set<string>();
		const out: { title: string; params: ParamMeta[] }[] = [];
		for (const g of GROUPS) {
			const params = g.keys.flatMap((k) => {
				const p = byKey.get(k);
				if (!p) return [];
				placed.add(k);
				return [p];
			});
			if (params.length) out.push({ title: g.title, params });
		}
		const rest = paramSchema.filter((p) => !placed.has(p.key));
		if (rest.length) out.push({ title: 'Other', params: rest });
		return out;
	});

	let baseline = $state<Record<string, string>>({});
	let everLoaded = $state(false);

	$effect(() => {
		if (!settingsLoaded) return;
		everLoaded = true;
		if (settingsDirty) return;
		const next: Record<string, string> = {};
		for (const p of paramSchema) next[p.key] = paramValue(p.key);
		baseline = next;
	});

	const savedFor = (p: ParamMeta) =>
		savedValues ? (savedValues[p.key] ?? p.defaultValue) : (baseline[p.key] ?? p.defaultValue);

	const changed = $derived(paramSchema.filter((p) => paramValue(p.key) !== savedFor(p)));
	const restarts = $derived(changed.some((p) => p.requiresRestart));

	function invalid(p: ParamMeta, raw: string) {
		const v = raw.trim();
		if (v === '') return false;
		if (p.kind === 'int') {
			if (!/^-?\d+$/.test(v)) return true;
			const n = Number(v);
			return (p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max);
		}
		if (p.kind === 'memory') return !/^\d+(kB|MB|GB)$/.test(v);
		return false;
	}

	const hasInvalid = $derived(paramSchema.some((p) => invalid(p, paramValue(p.key))));

	const advisoryFor = (key: string) => settingsAdvisories.find((a) => a.key === key)?.message;
	const looseAdvisories = $derived(
		settingsAdvisories.filter((a) => !paramSchema.some((p) => p.key === a.key))
	);

	function discard() {
		if (onDiscardSettings) onDiscardSettings();
		else onFetchSettings();
	}
</script>

{#if database.mode !== 'cnpg'}
	<SectionCard title="PostgreSQL parameters">
		<EmptyState title="Parameters need a dedicated database" />
	</SectionCard>
{:else if !everLoaded && !settingsLoaded}
	<SectionCard title="PostgreSQL parameters">
		<SettingsList>
			{#each [0, 1, 2, 3] as i (i)}
				<div class="param-skeleton">
					<Skeleton width="9rem" height="0.875rem" />
					<Skeleton width="11rem" height="2rem" />
				</div>
			{/each}
		</SettingsList>
	</SectionCard>
{:else}
	<SectionCard title="PostgreSQL parameters">
		<div class="params">
			{#each looseAdvisories as a (a.key)}
				<Alert tone="warning">{a.message}</Alert>
			{/each}
			{#each groups as g (g.title)}
				<div class="param-group">
					<SectionTitle title={g.title} />
					<SettingsList label={g.title}>
						{#each g.params as p (p.key)}
							<ParamRow
								param={p}
								value={paramValue(p.key)}
								invalid={invalid(p, paramValue(p.key))}
								drift={p.key in settingsDrift ? settingsDrift[p.key] : undefined}
								advisory={advisoryFor(p.key)}
								onchange={(v) => setParam(p.key, v)}
							/>
						{/each}
					</SettingsList>
				</div>
			{/each}
			{#if changed.length > 0 || settingsSaving}
				<div class="param-save" in:presence out:presence>
					<FormActions hint={restarts ? 'Saving restarts the database' : undefined}>
						<Button variant="ghost" disabled={settingsSaving} onclick={discard}>Discard</Button>
						<Button
							variant="primary"
							loading={settingsSaving}
							disabled={hasInvalid}
							onclick={onSaveSettings}
						>
							Save
						</Button>
					</FormActions>
				</div>
			{/if}
		</div>
	</SectionCard>
{/if}

<style>
	.params {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}
	.param-group {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.param-skeleton {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
	}
	.param-save {
		position: sticky;
		bottom: 0;
		z-index: 1;
		margin: 0 calc(var(--space-4) * -1) calc(var(--space-4) * -1);
		padding: var(--space-1) var(--space-4) var(--space-4);
		background: var(--bg-surface);
		box-shadow: inset 0 1px 0 var(--border-default);
	}
</style>
