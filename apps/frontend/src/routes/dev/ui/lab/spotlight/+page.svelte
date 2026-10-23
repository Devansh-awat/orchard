<script lang="ts">
	import ProjectSpotlight from '$lib/components/patterns/ProjectSpotlight.svelte';
	import DevBar from '../../DevBar.svelte';
	import { SPOTLIGHT as items } from '../../home-fixtures';
</script>

<div class="lab">
	<section class="slot">
		<h1 class="label">Spotlight</h1>
		<ProjectSpotlight {items} variant="spotlight" />
	</section>
	<section class="slot">
		<h1 class="label">Spotlight, no art</h1>
		<ProjectSpotlight items={[items[1]]} variant="spotlight" />
	</section>
	<section class="slot">
		<h1 class="label">Banner</h1>
		<ProjectSpotlight {items} variant="banner" />
	</section>
</div>

<DevBar />

<style>
	.lab {
		display: flex;
		flex-direction: column;
		gap: 2rem;
		max-width: var(--page-wide);
		margin: 0 auto;
		padding: 2rem 2rem 6rem;
	}
	.slot {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.label {
		color: var(--text-muted);
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
	}
</style>
