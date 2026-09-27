<script lang="ts">
	import { Loader2, Plus, Trash2, BellRing } from 'lucide-svelte';
	import {
		Button,
		EmptyState,
		Select,
		Input,
		Field,
		StatusBadge,
		statusMeta
	} from '$lib/components/ui';
	import { motionStagger, stateEcho } from '$lib/utils/motion.svelte';
	import { slide } from '$lib/utils/transitions';
	import { toasts } from '$lib/stores';
	import type { NotificationScopeType } from './types';
	import {
		WINDOW_OPTIONS,
		createAlertRule,
		deleteAlertRule,
		fetchAlertCatalogue,
		fetchAlertRules,
		fetchAlertStates,
		statusLabel,
		statusTone,
		updateAlertRule,
		windowLabel,
		type AlertComparator,
		type AlertMetric,
		type AlertMetricId,
		type AlertRule,
		type AlertState
	} from './alerts';

	let {
		organizationId,
		scopeType,
		scopeId = null,
		canEdit = true
	}: {
		organizationId: string;
		scopeType: NotificationScopeType;
		scopeId?: string | null;
		canEdit?: boolean;
	} = $props();

	let loading = $state(true);
	let rules = $state<AlertRule[]>([]);
	let states = $state<AlertState[]>([]);
	let catalogue = $state<AlertMetric[]>([]);
	let busyId = $state<string | null>(null);
	let formOpen = $state(false);
	let saving = $state(false);
	let formMetric = $state<AlertMetricId>('cpu_percent');
	let formComparator = $state<AlertComparator>('gt');
	let formThreshold = $state('85');
	let formFor = $state('300');
	let formMinRate = $state('');

	const metric = $derived(catalogue.find((m) => m.id === formMetric) ?? null);
	const stateByRule = $derived(new Map(states.map((s) => [s.ruleId, s])));
	const own = $derived(rules.filter((r) => !r.inherited));
	const inherited = $derived(rules.filter((r) => r.inherited));
	const canSubmit = $derived(
		!!metric && Number.isFinite(Number(formThreshold)) && Number(formThreshold) >= 0
	);

	async function load() {
		loading = true;
		try {
			const [r, c] = await Promise.all([
				fetchAlertRules(organizationId, scopeType, scopeId),
				catalogue.length ? Promise.resolve(catalogue) : fetchAlertCatalogue(organizationId)
			]);
			rules = r;
			catalogue = c;
			states =
				scopeType === 'deployment' && scopeId
					? await fetchAlertStates(organizationId, scopeId)
					: [];
		} catch (e) {
			toasts.add({
				title: 'Could not load alerts',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (organizationId) void load();
	});

	function pickMetric(id: string) {
		formMetric = id as AlertMetricId;
		const def = catalogue.find((m) => m.id === id);
		if (!def) return;
		formComparator = def.comparators[0];
		formThreshold = String(def.defaultThreshold);
		formFor = String(def.defaultForSeconds);
	}

	function openCreate() {
		pickMetric(catalogue[0]?.id ?? 'cpu_percent');
		formMinRate = '';
		formOpen = true;
	}

	async function submit() {
		if (!canSubmit || saving || !metric) return;
		saving = true;
		try {
			await createAlertRule(organizationId, {
				scopeType,
				scopeId,
				metric: metric.id,
				comparator: formComparator,
				threshold: Number(formThreshold),
				forSeconds: Number(formFor),
				minRequestRate:
					metric.requestRateGuard && formMinRate.trim() !== '' ? Number(formMinRate) : undefined
			});
			formOpen = false;
			await load();
		} catch (e) {
			toasts.add({
				title: 'Could not create the alert',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}

	async function toggle(rule: AlertRule) {
		busyId = rule.id;
		try {
			await updateAlertRule(organizationId, rule.id, { enabled: !rule.enabled });
			await load();
		} catch (e) {
			toasts.add({
				title: 'Could not update the alert',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			busyId = null;
		}
	}

	async function remove(rule: AlertRule) {
		busyId = rule.id;
		try {
			await deleteAlertRule(organizationId, rule.id);
			rules = rules.filter((r) => r.id !== rule.id);
		} catch (e) {
			toasts.add({
				title: 'Could not delete the alert',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			busyId = null;
		}
	}

	function thresholdSuffix(m: AlertMetric | null): string {
		return m ? m.unit : '';
	}
</script>

<div class="ar">
	<div class="ar-head">
		<span class="ar-title">Alerts</span>
		{#if canEdit && !formOpen}
			<Button variant="secondary" size="sm" onclick={openCreate} disabled={loading}>
				<Plus class="h-3.5 w-3.5" />
				<span>Add</span>
			</Button>
		{/if}
	</div>

	{#if formOpen}
		<form
			class="ar-form"
			transition:slide={{ duration: 160 }}
			onsubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<div class="ar-form-row">
				<Field label="Metric">
					<Select value={formMetric} onchange={(e) => pickMetric(e.currentTarget.value)}>
						{#each catalogue as m (m.id)}
							<option value={m.id}>{m.label}</option>
						{/each}
					</Select>
				</Field>
				<Field label="Is">
					<Select bind:value={formComparator}>
						{#each metric?.comparators ?? ['gt'] as c (c)}
							<option value={c}>{c === 'gt' ? 'above' : 'below'}</option>
						{/each}
					</Select>
				</Field>
				<Field label={thresholdSuffix(metric)}>
					<Input type="number" min="0" step="any" bind:value={formThreshold} />
				</Field>
				<Field label="For">
					<Select bind:value={formFor}>
						{#each WINDOW_OPTIONS as w (w)}
							<option value={String(w)}>{windowLabel(w)}</option>
						{/each}
					</Select>
				</Field>
				{#if metric?.requestRateGuard}
					<Field label="Min req/s" hint="Skipped below this traffic">
						<Input type="number" min="0" step="any" placeholder="0.2" bind:value={formMinRate} />
					</Field>
				{/if}
			</div>
			{#if metric?.needsIngress}
				<span class="ar-note">Needs a domain on the app. Apps without one are skipped.</span>
			{/if}
			<div class="ar-form-actions">
				<Button variant="ghost" size="sm" onclick={() => (formOpen = false)} disabled={saving}>
					Cancel
				</Button>
				<Button
					variant="primary"
					size="sm"
					type="submit"
					disabled={!canSubmit || saving}
					loading={saving}
				>
					Add alert
				</Button>
			</div>
		</form>
	{/if}

	{#if loading}
		<div class="ar-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
	{:else if rules.length === 0 && !formOpen}
		<EmptyState
			title="No alerts"
			description={canEdit ? 'Add one to hear when a metric crosses a line.' : ''}
		>
			{#snippet icon()}<BellRing size={22} />{/snippet}
		</EmptyState>
	{:else}
		<ul class="ar-list">
			{#each [...own, ...inherited] as rule, i (rule.id)}
				{@const st = stateByRule.get(rule.id)}
				{@const tone = st ? statusTone(st.status) : rule.enabled ? 'success' : 'neutral'}
				<li
					class="ar-row motion-echo echo--{tone}"
					class:ar-row--off={!rule.enabled}
					{@attach motionStagger({ index: i, from: { y: 4 } })}
					{@attach stateEcho(() => st?.status ?? (rule.enabled ? 'on' : 'off'))}
				>
					<div class="ar-row-main">
						<span class="ar-row-title">{rule.description}</span>
						<span class="ar-row-sub">
							{#if rule.inherited}
								<span>from {rule.scopeType === 'org' ? 'the organization' : 'the project'}</span>
							{/if}
							{#if st?.valueLabel}
								<span class="ar-mono">now {st.valueLabel}</span>
							{/if}
							{#if rule.activeEpisodes > 0 && scopeType !== 'deployment'}
								<span
									>{rule.activeEpisodes} app{rule.activeEpisodes === 1 ? '' : 's'} over the line</span
								>
							{/if}
						</span>
					</div>
					{#if st}
						<StatusBadge
							meta={statusMeta(
								statusTone(st.status),
								statusLabel(st.status),
								st.status === 'firing'
							)}
						/>
					{:else}
						<StatusBadge
							meta={statusMeta(rule.enabled ? 'success' : 'neutral', rule.enabled ? 'On' : 'Off')}
						/>
					{/if}
					{#if canEdit && !rule.inherited}
						<div class="ar-row-actions">
							<Button
								variant="ghost"
								size="sm"
								onclick={() => toggle(rule)}
								disabled={busyId === rule.id}
							>
								{rule.enabled ? 'Pause' : 'Resume'}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onclick={() => remove(rule)}
								disabled={busyId === rule.id}
								aria-label="Delete alert"
							>
								<Trash2 class="h-3.5 w-3.5" />
							</Button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.ar {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.ar-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.ar-title {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--text-default);
	}
	.ar-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-3);
		border-radius: var(--radius-lg);
		background: var(--bg-sunken);
		box-shadow: inset 0 0 0 1px var(--rule);
	}
	.ar-form-row {
		display: grid;
		grid-template-columns:
			minmax(9rem, 1.4fr) minmax(6rem, 0.8fr) minmax(5rem, 0.7fr) minmax(6rem, 0.8fr)
			minmax(6rem, 0.8fr);
		gap: var(--space-2);
		align-items: end;
	}
	.ar-note {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
	.ar-form-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
	.ar-loading {
		display: flex;
		justify-content: center;
		padding: var(--space-4);
		color: var(--text-faint);
	}
	.ar-list {
		display: flex;
		flex-direction: column;
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.ar-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0.5rem 0.625rem;
		border-radius: var(--radius-md);
		border-top: 1px solid var(--rule);
	}
	.ar-row:first-child {
		border-top: none;
	}
	.ar-row--off .ar-row-title {
		color: var(--text-muted);
	}
	.ar-row-main {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
		flex: 1;
	}
	.ar-row-title {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ar-row-sub {
		display: flex;
		gap: var(--space-2);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ar-mono {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}
	.ar-row-actions {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		opacity: 0.7;
		transition: opacity var(--dur-fast);
	}
	.ar-row:hover .ar-row-actions,
	.ar-row:focus-within .ar-row-actions {
		opacity: 1;
	}
	@media (max-width: 760px) {
		.ar-form-row {
			grid-template-columns: 1fr 1fr;
		}
	}
</style>
