<script lang="ts">
	import { onMount } from 'svelte';
	import { List, ListRow, SectionCard, Skeleton, StatusDot } from '$lib/components/ui';
	import { statusMeta } from '$lib/components/ui/status';
	import { instanceChecklist, instanceChecklistOutstanding } from '$lib/stores';

	let loading = $state(true);

	const total = $derived($instanceChecklist.length);
	const left = $derived($instanceChecklistOutstanding.length);
	const heading = $derived(
		left === 0 ? 'This instance is fully set up' : `${left} of ${total} things left to set up`
	);

	function itemMeta(item: { done: boolean; severity: 'normal' | 'warning' }) {
		if (item.done) return statusMeta('success', 'Done');
		if (item.severity === 'warning') return statusMeta('warning', 'Needs attention');
		return statusMeta('neutral', 'To do');
	}

	onMount(async () => {
		await instanceChecklist.load(true);
		loading = false;
	});
</script>

{#if loading}
	<Skeleton class="h-44 w-full" />
{:else if total > 0}
	<SectionCard
		title={heading}
		description={left === 0 ? undefined : 'These are optional. Each one turns on a feature.'}
	>
		<List inset={false}>
			{#each $instanceChecklist as item (item.id)}
				<ListRow
					flush
					title={item.title}
					subtitle={item.detail}
					href={!item.done ? item.href : undefined}
				>
					{#snippet leading()}
						<StatusDot meta={itemMeta(item)} label={itemMeta(item).label} />
					{/snippet}
				</ListRow>
			{/each}
		</List>
	</SectionCard>
{/if}
