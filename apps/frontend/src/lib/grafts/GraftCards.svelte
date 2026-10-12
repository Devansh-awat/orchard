<script lang="ts">
	import GraftMount from './GraftMount.svelte';
	import { graftHost } from './host.svelte';
	import type { DeploymentProps, ProjectProps } from './types';

	let {
		slot,
		props
	}:
		| { slot: 'deployment.overview.cards'; props: DeploymentProps }
		| { slot: 'project.overview.cards'; props: ProjectProps } = $props();

	const cards = $derived(graftHost.slot(slot, props));
</script>

{#if cards.length}
	<div class="graft-cards">
		{#each cards as card (`${card.graftId}:${card.item.id}`)}
			<GraftMount
				graftId={card.graftId}
				mount={card.item.mount as (
					target: HTMLElement,
					p: typeof props,
					host: typeof card.host
				) => void}
				{props}
				host={card.host}
			/>
		{/each}
	</div>
{/if}

<style>
	.graft-cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
		gap: 1rem;
		margin-top: 1rem;
	}
</style>
