<script lang="ts">
	import { Loader2, FlaskConical, ExternalLink } from 'lucide-svelte';
	import type { EarlyAccessFeature } from '$lib/posthog';

	let {
		earlyAccessFeatures,
		earlyAccessLoading,
		earlyAccessEnrollment,
		togglingFeature,
		onToggleFeature,
	}: {
		earlyAccessFeatures: EarlyAccessFeature[];
		earlyAccessLoading: boolean;
		earlyAccessEnrollment: Record<string, boolean>;
		togglingFeature: string | null;
		onToggleFeature: (feature: EarlyAccessFeature) => void;
	} = $props();
</script>

{#if earlyAccessLoading || earlyAccessFeatures.length > 0}
	<div class="us-card-section">
		<div class="us-section-head">
			<div class="us-section-icon us-section-icon--eaf">
				<FlaskConical class="h-4 w-4" />
			</div>
			<div class="us-section-title-group">
				<h2 class="us-section-title">Early Access Features</h2>
				<p class="us-section-desc">Try features still in development. Expect rough edges.</p>
			</div>
			{#if !earlyAccessLoading && earlyAccessFeatures.length > 0}
				<span class="us-count">{earlyAccessFeatures.length}</span>
			{/if}
		</div>

		{#if earlyAccessLoading}
			<div class="us-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
		{:else}
			<div class="us-eaf-list">
				{#each earlyAccessFeatures as feature (feature.flagKey)}
					{@const enrolled = earlyAccessEnrollment[feature.flagKey] ?? false}
					<div class="us-eaf-row">
						<div class="us-eaf-body">
							<div class="us-eaf-top">
								<span class="us-eaf-name">{feature.name}</span>
								<span class="us-eaf-stage">{feature.stage}</span>
							</div>
							<p class="us-eaf-desc">{feature.description}</p>
							{#if feature.documentationUrl}
								<a
									class="us-eaf-doc"
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
							class="us-btn"
							class:us-btn-danger={enrolled}
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
	</div>
{/if}
