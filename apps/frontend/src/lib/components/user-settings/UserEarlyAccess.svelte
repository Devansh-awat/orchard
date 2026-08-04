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
		title="Early access"
		description="Try features still in development. Expect rough edges."
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
		padding: 0 0.5rem;
		border-radius: var(--radius-pill);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		background-color: var(--accent-subtle);
		color: var(--accent);
	}
	.ea-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-6) 0;
		color: var(--text-muted);
	}
	.ea-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.ea-item {
		display: flex;
		align-items: flex-start;
		gap: var(--space-4);
		padding: var(--space-3) 0;
	}
	.ea-item + .ea-item {
		border-top: 1px solid var(--rule);
	}
	.ea-item-body {
		flex: 1;
		min-width: 0;
	}
	.ea-item-top {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-bottom: var(--space-1);
	}
	.ea-item-name {
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: 600;
		letter-spacing: var(--track-body);
		color: var(--text-default);
	}
	.ea-stage {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		text-transform: capitalize;
		padding: 0.125rem var(--space-2);
		border-radius: var(--radius-pill);
		background-color: color-mix(in srgb, var(--status-warning) 14%, transparent);
		color: var(--status-warning);
	}
	.ea-desc {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
		margin: 0;
	}
	.ea-doc-link {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		margin-top: 0.5rem;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-link);
		text-decoration: none;
	}
	.ea-doc-link:hover {
		text-decoration: underline;
	}
	.ea-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.875rem;
		border-radius: var(--radius-sm);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		border: none;
		cursor: pointer;
		transition:
			background-color var(--dur-fast),
			color var(--dur-fast),
			opacity var(--dur-fast);
		white-space: nowrap;
		flex-shrink: 0;
		background-color: var(--accent);
		color: var(--text-on-accent);
	}
	.ea-toggle:hover:not(:disabled) {
		opacity: 0.9;
	}
	.ea-toggle:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.ea-toggle--leave {
		background-color: color-mix(in srgb, var(--status-error) 10%, transparent);
		color: var(--status-error);
	}
	.ea-toggle--leave:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--status-error) 16%, transparent);
		opacity: 1;
	}
</style>
