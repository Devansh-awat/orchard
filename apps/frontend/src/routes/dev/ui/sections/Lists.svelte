<script lang="ts">
	import { Plus, Ellipsis, Box } from 'lucide-svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Card from '$lib/components/ui/Card.svelte';
	import List from '$lib/components/ui/List.svelte';
	import ListRow from '$lib/components/ui/ListRow.svelte';
	import Metric from '$lib/components/ui/Metric.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import EntityRow from '$lib/components/patterns/EntityRow.svelte';
	import { PROJECTS } from '../fixtures';
</script>

<div class="grid grid-cols-2 gap-6">
	<div class="flex flex-col gap-3">
		<h2 class="text-headline text-fg">Lists and entities</h2>
		<List>
			{#each PROJECTS[0].entities.concat(PROJECTS[1].entities) as e (e.name)}
				<EntityRow {...e} href="#">
					{#snippet actions()}
						<Menu>
							{#snippet trigger(props)}<Button
									{...props}
									size="sm"
									variant="ghost"
									icon={Ellipsis}
									label="Actions"
								/>{/snippet}
							<MenuItem>Redeploy</MenuItem>
							<MenuItem>Copy URL</MenuItem>
							<MenuItem danger>Delete</MenuItem>
						</Menu>
					{/snippet}
				</EntityRow>
			{/each}
		</List>
		<List>
			<ListRow title="Plain row" subtitle="With a subtitle" />
			<ListRow title="Clickable row" subtitle="Whole row is the hit target" href="#">
				{#snippet trailing()}<RelativeTime date={Date.now() - 3 * 3600_000} />{/snippet}
			</ListRow>
		</List>
	</div>
	<div class="flex flex-col gap-3">
		<h2 class="text-headline text-fg">Cards and metrics</h2>
		<div class="grid grid-cols-2 gap-3">
			<Card><Metric label="CPU" value="0.42" unit="cores" detail="of 1 core" /></Card>
			<Card
				><Metric label="Memory" value="471" unit="MB" detail="92% of 512 MB" tone="warning" /></Card
			>
			<Card><Metric label="Requests" value="12.4k" detail="+8% vs yesterday" tone="success" /></Card
			>
			<Card href="#"><Metric label="Replicas" value="3" detail="Interactive card" /></Card>
		</div>
		<Card padding="none">
			<EmptyState
				title="No databases yet"
				description="Spin up Postgres or Redis next to your app in a few seconds."
			>
				{#snippet icon()}<Box size={18} />{/snippet}
				<Button variant="primary" size="sm" icon={Plus}>New database</Button>
			</EmptyState>
		</Card>
	</div>
</div>
