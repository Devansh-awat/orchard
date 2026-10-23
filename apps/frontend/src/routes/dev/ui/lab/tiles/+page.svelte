<script lang="ts">
	import AppFrame from '$lib/components/patterns/AppFrame.svelte';
	import Sidebar from '$lib/components/patterns/Sidebar.svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import SectionTitle from '$lib/components/ui/SectionTitle.svelte';
	import ProjectTiles from '$lib/components/patterns/ProjectTiles.svelte';
	import ProjectInsetList from '$lib/components/patterns/ProjectInsetList.svelte';
	import { SIDEBAR } from '../../fixtures';
	import { TILE_PROJECTS } from '../../home-fixtures';

	const projects = TILE_PROJECTS;
	const sections = SIDEBAR.sections('apps');
	let expanded = $state(['p2']);
</script>

<AppFrame>
	{#snippet sidebar()}
		<Sidebar org={SIDEBAR.org} user={SIDEBAR.user} {sections} />
	{/snippet}
	<Page title="Your Apps" width="wide">
		<div class="lab">
			<section class="specimen">
				<SectionTitle title="Tiles" count={projects.length} />
				<ProjectTiles {projects} />
			</section>
			<section class="specimen">
				<SectionTitle title="Inset list" count={projects.length} />
				<ProjectInsetList {projects} bind:expanded />
			</section>
		</div>
	</Page>
</AppFrame>

<style>
	.lab {
		display: flex;
		flex-direction: column;
		gap: 3rem;
		padding-bottom: 4rem;
	}
	.specimen {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
</style>
