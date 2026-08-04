<script lang="ts">
	import { Button } from '$lib/components/ui';
	import { toasts } from '$lib/stores';
	import { fetchScopeSettings, saveScopeSettings } from './api';
	import {
		CATEGORY_LABELS,
		SETTING_LABELS,
		categoriesForScope,
		type NotificationCategory,
		type NotificationScopeType,
		type ScopeSettings,
		type SettingValue
	} from './types';

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

	// The inherited answer is spelled out rather than implied, so it is obvious
	// whether you are looking at your own choice or a fallback from above.
	function inheritedFrom(source: string): string {
		if (source === 'default') return 'Orchard default';
		if (source === 'global') return 'your account default';
		if (source === 'org') return 'your setting for this organization';
		return `your setting for this ${source}`;
	}
</script>

<div class="pn">
	<div class="pn-head">
		<h4 class="pn-title">Your notifications</h4>
		<p class="pn-sub">
			Only affects you. Changing this never adds or removes a team channel above.
		</p>
	</div>

	{#if loading}
		<div class="pn-skeleton"></div>
	{:else if settings}
		<div class="pn-rows">
			{#each categories as category (category)}
				{@const state = settings.categories[category]}
				<div class="pn-row">
					<div class="pn-row-meta">
						<span class="pn-row-label">{CATEGORY_LABELS[category]}</span>
						{#if state && !state.own}
							<span class="pn-row-source">Following {inheritedFrom(state.source)}</span>
						{/if}
					</div>
					<div class="pn-seg" role="radiogroup" aria-label={CATEGORY_LABELS[category]}>
						{#each ['always', 'subscribed', 'never'] as const as option (option)}
							<button
								type="button"
								role="radio"
								aria-checked={state?.value === option}
								class="pn-seg-btn"
								class:pn-seg-btn-active={state?.value === option}
								disabled={saving === category}
								title={SETTING_LABELS[option].hint}
								onclick={() => choose(category, option)}
							>
								{SETTING_LABELS[option].label}
							</button>
						{/each}
					</div>
					{#if state?.own}
						<Button
							variant="ghost"
							size="sm"
							disabled={saving === category}
							onclick={() => choose(category, null)}
						>
							Reset
						</Button>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.pn {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.pn-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-fg);
		margin: 0;
	}

	.pn-sub {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin: 0.2rem 0 0;
		max-width: 46ch;
	}

	.pn-skeleton {
		height: 3.25rem;
		border-radius: var(--radius-md);
		background: var(--bg-raised);
		opacity: 0.6;
	}

	.pn-rows {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.pn-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		padding: 0.7rem 0.875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--bg-raised);
	}

	.pn-row-meta {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		flex: 1;
	}

	.pn-row-label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-fg);
	}

	.pn-row-source {
		font-size: 0.6875rem;
		color: var(--text-faint);
	}

	.pn-seg {
		display: inline-flex;
		padding: 0.15rem;
		gap: 0.15rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--bg-surface);
	}

	.pn-seg-btn {
		padding: 0.25rem 0.6rem;
		border: none;
		border-radius: calc(var(--radius-md) - 0.15rem);
		background: transparent;
		font-size: 0.75rem;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-base) ease,
			color var(--dur-base) ease;
	}

	.pn-seg-btn:hover:not(:disabled) {
		color: var(--text-fg);
	}

	.pn-seg-btn:disabled {
		cursor: default;
	}

	.pn-seg-btn-active {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		color: var(--text-fg);
	}
</style>
