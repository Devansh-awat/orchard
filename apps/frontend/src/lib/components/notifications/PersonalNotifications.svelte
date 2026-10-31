<script lang="ts">
	import {
		Button,
		SectionCard,
		SegmentedControl,
		SettingRow,
		SettingsList,
		Skeleton
	} from '$lib/components/ui';
	import { toasts } from '$lib/stores';
	import { fetchScopeSettings, saveScopeSettings } from './api';
	import {
		CATEGORY_LABELS,
		CATEGORY_OPTIONS,
		categoriesForScope,
		settingLabel,
		type NotificationCategory,
		type NotificationScopeType,
		type ScopeSettings,
		type SettingValue
	} from './types';

	const INHERIT = 'inherit';

	let {
		organizationId,
		scopeType,
		scopeId
	}: {
		organizationId: string;
		scopeType: NotificationScopeType;
		scopeId: string;
	} = $props();

	let loading = $state(true);
	let saving = $state<NotificationCategory | null>(null);
	let settings = $state<ScopeSettings | null>(null);

	const categories = $derived(categoriesForScope(scopeType));

	async function load() {
		loading = true;
		try {
			settings = await fetchScopeSettings(organizationId, scopeType, scopeId);
		} catch (e) {
			toasts.add({
				title: 'Could not load your notification settings',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (organizationId && scopeId) void load();
	});

	async function choose(category: NotificationCategory, value: SettingValue | null) {
		if (saving) return;
		saving = category;
		try {
			await saveScopeSettings(organizationId, scopeType, scopeId, { [category]: value });
			await load();
		} catch (e) {
			toasts.add({
				title: 'Could not save that',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			saving = null;
		}
	}

	function inheritedFrom(source: string): string {
		if (source === 'default') return 'the Orchard default';
		if (source === 'global') return 'your account default';
		if (source === 'org') return 'your setting for this organization';
		return `your setting for this ${source}`;
	}

	function options(category: NotificationCategory) {
		return [
			{ value: INHERIT, label: 'Default', disabled: saving === category },
			...(CATEGORY_OPTIONS[category] ?? ['always', 'subscribed', 'never']).map((option) => ({
				value: option,
				label: settingLabel(category, option).label,
				hint: settingLabel(category, option).hint,
				disabled: saving === category
			}))
		];
	}

	function hint(category: NotificationCategory): string | undefined {
		const state = settings?.categories?.[category];
		if (!state) return undefined;
		const choice = settingLabel(category, state.value);
		return state.own ? choice.hint : `${choice.label}, from ${inheritedFrom(state.source)}`;
	}
</script>

<SectionCard title="Your notifications">
	{#if loading && !settings}
		<div class="placeholder">
			<Skeleton height="2.75rem" />
			<Skeleton height="2.75rem" />
		</div>
	{:else if settings}
		<SettingsList label="Your notifications">
			{#each categories as category (category)}
				{@const state = settings.categories?.[category]}
				<SettingRow label={CATEGORY_LABELS[category]} hint={hint(category)}>
					<SegmentedControl
						size="sm"
						label={CATEGORY_LABELS[category]}
						value={state?.own ? state.value : INHERIT}
						options={options(category)}
						onchange={(v) => choose(category, v === INHERIT ? null : (v as SettingValue))}
					/>
				</SettingRow>
			{/each}
		</SettingsList>
	{:else}
		<p class="quiet">Could not load your notification settings.</p>
	{/if}
	{#snippet actions()}
		{#if !loading && !settings}
			<Button variant="ghost" size="sm" onclick={load}>Retry</Button>
		{/if}
	{/snippet}
</SectionCard>

<style>
	.placeholder {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.quiet {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
</style>
