<script lang="ts">
	import { FileText, Plus, Loader2 } from 'lucide-svelte';
	import { motionStagger, springHover, cardTilt } from '$lib/utils/motion.svelte';
	import { StatusBadge, resourceStatus } from '$lib/components/ui';
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

<div class="pj-deployments-header">
	<h2 class="pj-section-title">
		<FileText class="h-4 w-4" style="color: #0db7ed; display: inline;" />
		Compose Stacks
	</h2>
	<div style="margin-left: auto;">
		<a
			href="/{orgSlug}/projects/{projectSlug}/compose-stacks/new"
			class="pj-btn pj-btn-primary pj-btn--sm"
		>
			<Plus class="h-4 w-4" />
			New stack
		</a>
	</div>
</div>

{#if composeStacksLoading && composeStacks.length === 0}
	<div class="pj-empty-card">
		<Loader2 class="h-5 w-5 animate-spin" style="color: var(--surface-muted)" />
		<p>Loading compose stacks…</p>
	</div>
{:else if composeStacks.length === 0}
	<div class="pj-empty-card">
		<span style:color="var(--surface-muted)"><FileText class="h-10 w-10" /></span>
		<p>No compose stacks yet</p>
		<a
			href="/{orgSlug}/projects/{projectSlug}/compose-stacks/new"
			class="pj-btn pj-btn-primary pj-btn-mt"
		>
			<Plus class="h-4 w-4" />
			Deploy from compose file
		</a>
	</div>
{:else}
	<div class="pj-deployment-grid">
		{#each composeStacks as cs, i (cs.id)}
			<a
				href="/{orgSlug}/compose-stacks/{cs.id}"
				class="pj-deployment-card"
				{@attach motionStagger({ index: i, from: { y: 10 } })}
				{@attach springHover({ lift: -4, stiffness: 360, damping: 22 })}
				{@attach cardTilt({ max: 5 })}
			>
				<div class="pj-deployment-card-top">
					<div class="pj-deployment-indicator" style="color: var(--hue-blue)">
						<FileText class="h-5 w-5" />
					</div>
					<StatusBadge meta={resourceStatus(cs.status)} />
				</div>
				<div class="pj-deployment-card-body">
					<span class="pj-deployment-name">{cs.name}</span>
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
