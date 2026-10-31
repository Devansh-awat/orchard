<script lang="ts">
	import { ArrowUpRight } from 'lucide-svelte';
	import type { EarlyAccessFeature } from '$lib/posthog';
	import {
		Button,
		SectionCard,
		SettingRow,
		SettingsList,
		Skeleton,
		Switch
	} from '$lib/components/ui';

	let {
		earlyAccessFeatures,
		earlyAccessLoading,
		earlyAccessEnrollment,
		togglingFeature,
		onToggleFeature,
		index: _index = 0
	}: {
		earlyAccessFeatures: EarlyAccessFeature[];
		earlyAccessLoading: boolean;
		earlyAccessEnrollment: Record<string, boolean>;
		togglingFeature: string | null;
		onToggleFeature: (feature: EarlyAccessFeature) => void;
		index?: number;
	} = $props();

	function stageLabel(stage: string) {
		return stage ? stage.charAt(0).toUpperCase() + stage.slice(1) : '';
	}
</script>

<SectionCard title="Early access" description="Features still in development. Expect rough edges.">
	{#if earlyAccessLoading}
		<div class="placeholder">
			<Skeleton height="2.5rem" />
			<Skeleton height="2.5rem" />
		</div>
	{:else if earlyAccessFeatures.length === 0}
		<p class="quiet">Nothing to try right now.</p>
	{:else}
		<SettingsList label="Early access features">
			{#each earlyAccessFeatures as feature (feature.flagKey)}
				{@const stage = stageLabel(feature.stage)}
				<SettingRow
					label={feature.name}
					hint={[stage, feature.description].filter(Boolean).join(' · ')}
				>
					{#if feature.documentationUrl}
						<Button
							variant="ghost"
							size="sm"
							iconRight={ArrowUpRight}
							href={feature.documentationUrl}
							target="_blank"
							rel="noopener noreferrer">Docs</Button
						>
					{/if}
					<Switch
						label={feature.name}
						bind:checked={
							() => earlyAccessEnrollment[feature.flagKey] ?? false, () => onToggleFeature(feature)
						}
						disabled={togglingFeature === feature.flagKey}
					/>
				</SettingRow>
			{/each}
		</SettingsList>
	{/if}
</SectionCard>

<style>
	.placeholder {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.quiet {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
</style>
