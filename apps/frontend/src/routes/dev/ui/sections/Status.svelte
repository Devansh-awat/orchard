<script lang="ts">
	import Badge from '$lib/components/ui/Badge.svelte';
	import StatusBadge from '$lib/components/ui/StatusBadge.svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import { statusMeta, type StatusKind } from '$lib/components/ui/status';

	const KINDS: StatusKind[] = ['success', 'progress', 'warning', 'error', 'info', 'neutral'];
	const LABELS: Record<StatusKind, string> = {
		success: 'Ready',
		progress: 'Building',
		warning: 'Unhealthy',
		error: 'Crashing',
		info: 'Queued',
		neutral: 'Stopped'
	};
</script>

<SectionCard
	title="Status"
	description="Quiet when healthy. Live dot only while something is in flight."
>
	<div class="flex flex-col gap-3">
		<div class="flex flex-wrap gap-2">
			{#each KINDS as k (k)}<StatusBadge meta={statusMeta(k, LABELS[k], k === 'progress')} />{/each}
		</div>
		<div class="flex flex-wrap gap-2">
			{#each KINDS as k (k)}<StatusBadge variant="solid" meta={statusMeta(k, LABELS[k])} />{/each}
		</div>
		<div class="flex flex-wrap gap-4">
			{#each KINDS as k (k)}<StatusBadge
					variant="plain"
					meta={statusMeta(k, LABELS[k], k === 'progress')}
				/>{/each}
		</div>
		<div class="flex flex-wrap gap-2">
			<Badge>Hobby</Badge>
			<Badge tone="accent">New</Badge>
			<Badge tone="success">+12%</Badge>
			<Badge tone="warning">Expiring</Badge>
			<Badge tone="error">3 errors</Badge>
			<Badge tone="info">Beta</Badge>
		</div>
	</div>
</SectionCard>
