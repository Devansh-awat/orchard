<script lang="ts">
	import { page } from '$app/stores';
	import { EmptyState } from '$lib/components/ui';
	import GraftMount from '$lib/grafts/GraftMount.svelte';
	import { graftHost } from '$lib/grafts/host.svelte';
	import { findScreen } from '$lib/grafts/registry';

	$effect(() => {
		void graftHost.load();
	});

	const match = $derived(findScreen($page.url.pathname));
	const loaded = $derived(match ? graftHost.byId(match.graft.id) : undefined);
	const mount = $derived(match && loaded ? loaded.client.screens?.[match.screen.id] : undefined);
	const screenProps = $derived({
		path: $page.url.pathname,
		params: match?.params ?? {},
		search: $page.url.search
	});
</script>

<svelte:head>
	{#if match}<title>{match.screen.title ?? match.graft.name} · Orchard</title>{/if}
</svelte:head>

{#if !match}
	<EmptyState title="Nothing here" description="No installed graft has a page at this address." />
{:else if !graftHost.ready}
	<div class="graft-screen-loading" aria-busy="true"></div>
{:else if graftHost.failed[match.graft.id]}
	<EmptyState
		title={`${match.graft.name} couldn't load`}
		description={graftHost.failed[match.graft.id]}
	/>
{:else if loaded && mount}
	{#key mount}
		<GraftMount
			graftId={match.graft.id}
			{mount}
			props={screenProps}
			host={loaded.host}
			class={match.screen.layout === 'fullscreen'
				? 'graft-screen graft-screen-full'
				: 'graft-screen'}
		/>
	{/key}
{:else}
	<EmptyState
		title="Screen missing"
		description={`${match.graft.name} declares the "${match.screen.id}" screen but its UI doesn't provide it.`}
	/>
{/if}

<style>
	:global(.graft-screen-full) {
		height: 100vh;
	}

	.graft-screen-loading {
		min-height: 40vh;
	}
</style>
