<script lang="ts">
	import { Loader2, ExternalLink } from 'lucide-svelte';
	import { Sparkles } from '@jis3r/icons';
	import type { EarlyAccessFeature } from '$lib/posthog';
	import SettingsSection from './SettingsSection.svelte';

	let {
		earlyAccessFeatures,
		earlyAccessLoading,
		earlyAccessEnrollment,
		togglingFeature,
		onToggleFeature,
		index = 0
	}: {
		earlyAccessFeatures: EarlyAccessFeature[];
		earlyAccessLoading: boolean;
		earlyAccessEnrollment: Record<string, boolean>;
		togglingFeature: string | null;
		onToggleFeature: (feature: EarlyAccessFeature) => void;
		index?: number;
	} = $props();
</script>

{#if earlyAccessLoading || earlyAccessFeatures.length > 0}
	<SettingsSection
		{index}
		title="Early Access"
		description="Try features still in development. Expect rough edges."
		iconColor="amber"
	>
		{#snippet icon(hovered)}<Sparkles size={18} animate={hovered} />{/snippet}
		{#snippet badge()}
			{#if !earlyAccessLoading && earlyAccessFeatures.length > 0}
				<span class="ea-count">{earlyAccessFeatures.length}</span>
			{/if}
		{/snippet}

		{#if earlyAccessLoading}
			<div class="ea-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
		{:else}
			<div class="ea-list">
				{#each earlyAccessFeatures as feature (feature.flagKey)}
					{@const enrolled = earlyAccessEnrollment[feature.flagKey] ?? false}
					<div class="ea-item">
						<div class="ea-item-body">
							<div class="ea-item-top">
								<span class="ea-item-name">{feature.name}</span>
								<span class="ea-stage">{feature.stage}</span>
							</div>
							<p class="ea-desc">{feature.description}</p>
							{#if feature.documentationUrl}
								<a
									class="ea-doc-link"
									href={feature.documentationUrl}
									target="_blank"
									rel="noopener noreferrer"
								>
									Documentation <ExternalLink class="h-3 w-3" />
								</a>
							{/if}
						</div>
						<button
							type="button"
							class="ea-toggle"
							class:ea-toggle--leave={enrolled}
							onclick={() => onToggleFeature(feature)}
							disabled={togglingFeature === feature.flagKey}
						>
							{#if togglingFeature === feature.flagKey}
								<Loader2 class="h-3.5 w-3.5 animate-spin" />
							{:else if enrolled}
								Leave beta
							{:else}
								Join beta
							{/if}
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</SettingsSection>
{/if}

<style>
	.ea-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.375rem;
		border-radius: 2rem;
		font-size: 0.6875rem;
		font-weight: 650;
		background-color: color-mix(in srgb, var(--button-bg) 10%, transparent);
		color: var(--button-bg);
	}
	.ea-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem 0;
		color: var(--surface-muted);
	}
	.ea-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.ea-item {
		display: flex;
		align-items: flex-start;
		gap: 1rem;
		padding: 0.75rem 0;
	}
	.ea-item + .ea-item {
		border-top: 1px solid color-mix(in srgb, var(--center-channel-color) 8%, transparent);
	}
	.ea-item-body {
		flex: 1;
		min-width: 0;
	}
	.ea-item-top {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.25rem;
	}
	.ea-item-name {
		font-weight: 600;
		color: var(--center-channel-color);
	}
	.ea-stage {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 0.125rem 0.5rem;
		border-radius: 999px;
		background-color: color-mix(in srgb, var(--away-indicator) 14%, transparent);
		color: var(--away-indicator);
	}
	.ea-desc {
		font-size: 0.85rem;
		color: color-mix(in srgb, var(--center-channel-color) 70%, transparent);
		margin: 0;
	}
	.ea-doc-link {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		margin-top: 0.375rem;
		font-size: 0.8rem;
		color: var(--link-color);
		text-decoration: none;
	}
	.ea-doc-link:hover {
		text-decoration: underline;
	}
	.ea-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 550;
		border: none;
		cursor: pointer;
		transition: all 120ms;
		white-space: nowrap;
		flex-shrink: 0;
		background-color: var(--button-bg);
		color: var(--button-color);
	}
	.ea-toggle:hover:not(:disabled) {
		opacity: 0.9;
	}
	.ea-toggle:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.ea-toggle--leave {
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
	}
	.ea-toggle--leave:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--error-text-color) 16%, transparent);
		opacity: 1;
	}
</style>
