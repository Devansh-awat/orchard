<script lang="ts">
	import LiquidNewButton from '$lib/components/patterns/LiquidNewButton.svelte';
	import DevBar from '../../DevBar.svelte';

	const APPS = [
		{ name: 'api', meta: 'Running, 3 replicas' },
		{ name: 'web', meta: 'Running, 2 replicas' },
		{ name: 'worker', meta: 'Running, 1 replica' },
		{ name: 'postgres', meta: 'Healthy, 4 GB' },
		{ name: 'nightly-sync', meta: 'Next run in 3 hours' },
		{ name: 'redis', meta: 'Healthy, 256 MB' }
	];

	let picked = $state<string | null>(null);
</script>

<div class="lab">
	<header class="masthead">
		<h1 class="heading">Your Apps</h1>
		<LiquidNewButton onSelect={(id) => (picked = id)} />
	</header>
	<p class="picked">{picked ? `Picked ${picked}` : 'Nothing picked yet'}</p>
	<div class="apps">
		{#each APPS as app (app.name)}
			<div class="app">
				<span class="name">{app.name}</span>
				<span class="meta">{app.meta}</span>
			</div>
		{/each}
	</div>
</div>

<DevBar />

<style>
	.lab {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		max-width: var(--page-wide);
		margin: 0 auto;
		padding: 2rem 2rem 6rem;
	}
	.masthead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.heading {
		font-size: var(--text-title-1);
		font-weight: var(--weight-semibold);
		color: var(--text-default);
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.picked {
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
	.apps {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: 0.75rem;
	}
	.app {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 1rem;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
	}
	.name,
	.meta {
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.name {
		font-size: var(--text-body);
		font-weight: var(--weight-medium);
		color: var(--text-default);
	}
	.meta {
		font-size: var(--text-callout);
		color: var(--text-muted);
	}
</style>
