<script lang="ts">
	import AppFrame from '$lib/components/patterns/AppFrame.svelte';
	import Sidebar from '$lib/components/patterns/Sidebar.svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import UpNextShelf from '$lib/components/patterns/UpNextShelf.svelte';
	import AppDock from '$lib/components/patterns/AppDock.svelte';
	import DevBar from '../../DevBar.svelte';
	import { SIDEBAR } from '../../fixtures';
	import { UP_NEXT as upNext, PINNED as pinned } from '../../home-fixtures';
</script>

<AppFrame>
	{#snippet sidebar()}
		<Sidebar org={SIDEBAR.org} user={SIDEBAR.user} sections={SIDEBAR.sections('apps')} />
	{/snippet}
	<Page title="Your Apps" width="wide">
		<div class="lab">
			<UpNextShelf items={upNext} seeAllHref="#" />
			<AppDock items={pinned} />
		</div>
	</Page>
</AppFrame>

<DevBar />

<style>
	.lab {
		display: flex;
		flex-direction: column;
		gap: 3rem;
		padding-bottom: 6rem;
	}
</style>
