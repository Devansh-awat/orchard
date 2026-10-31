<script lang="ts">
	import { RefreshCw, RotateCcw } from 'lucide-svelte';
	import { Button, SearchField } from '$lib/components/ui';

	let {
		querySearch = $bindable(''),
		refreshing,
		resetting,
		onRefresh,
		onReset
	}: {
		querySearch: string;
		refreshing: boolean;
		resetting: boolean;
		onRefresh: () => void;
		onReset: () => void;
	} = $props();
</script>

<div class="observe-query-controls">
	<div class="search">
		<SearchField size="sm" placeholder="Filter queries" bind:value={querySearch} />
	</div>
	<Button variant="ghost" size="sm" icon={RotateCcw} loading={resetting} onclick={onReset}>
		Reset
	</Button>
	<Button
		variant="ghost"
		size="sm"
		icon={RefreshCw}
		label="Refresh"
		loading={refreshing}
		onclick={onRefresh}
	/>
</div>

<style>
	.observe-query-controls {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.search {
		width: 15rem;
		margin-right: 0.25rem;
	}
</style>
