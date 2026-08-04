<script lang="ts">
	import { FileText, Plus, Loader2 } from 'lucide-svelte';
	import { motionStagger, springHover } from '$lib/utils/motion.svelte';
	import {
		StatusBadge,
		resourceStatus,
		SectionHeader,
		Button,
		EmptyState
	} from '$lib/components/ui';
	import type { ComposeStackSummary } from './types';

	let {
		composeStacks,
		composeStacksLoading = false,
		orgSlug,
		projectSlug
	}: {
		composeStacks: ComposeStackSummary[];
		composeStacksLoading?: boolean;
		orgSlug: string;
		projectSlug: string;
	} = $props();
</script>

<div class="pj-section-card pj-glass">
	<SectionHeader title="Compose stacks" count={composeStacks.length}>
		{#snippet actions()}
			<Button
				href="/{orgSlug}/projects/{projectSlug}/compose-stacks/new"
				variant="secondary"
				size="sm"
			>
				<Plus size={14} />
				New stack
			</Button>
		{/snippet}
	</SectionHeader>

	{#if composeStacksLoading && composeStacks.length === 0}
		<div class="pj-inline-empty">
			<Loader2 class="h-5 w-5 animate-spin" style="color: var(--text-faint)" />
			<p>Loading compose stacks…</p>
		</div>
	{:else if composeStacks.length === 0}
		<EmptyState
			title="No compose stacks yet"
			description="Deploy a multi-service stack straight from a docker-compose file."
		>
			{#snippet icon()}<FileText size={20} />{/snippet}
			<Button
				href="/{orgSlug}/projects/{projectSlug}/compose-stacks/new"
				variant="primary"
				size="sm"
			>
				<Plus size={14} />
				Deploy from compose file
			</Button>
		</EmptyState>
	{:else}
		<div class="pj-deployment-grid pj-deployment-grid--nested">
			{#each composeStacks as cs, i (cs.id)}
				<a
					href="/{orgSlug}/compose-stacks/{cs.id}"
					class="pj-deployment-card pj-deployment-card--nested"
					{@attach motionStagger({ index: i, from: { y: 10 } })}
					{@attach springHover({ lift: -4 })}
				>
					<div class="pj-deployment-card-top">
						<div class="pj-deployment-indicator" style="color: var(--hue-blue)">
							<FileText class="h-5 w-5" />
						</div>
						<span class="pj-deployment-name">{cs.name}</span>
						<StatusBadge meta={resourceStatus(cs.status)} />
					</div>
					<div class="pj-deployment-card-body">
						<span class="pj-deployment-detail">docker-compose.yml</span>
					</div>
					<div class="pj-deployment-card-footer">
						<span class="pj-deployment-replicas">
							{cs.deployments?.length ?? 0} service{(cs.deployments?.length ?? 0) === 1 ? '' : 's'}
						</span>
					</div>
				</a>
			{/each}
		</div>
	{/if}
</div>
