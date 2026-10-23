<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		description = undefined,
		width = 'default',
		eyebrow = undefined,
		actions = undefined,
		aside = undefined,
		children
	}: {
		title: string;
		description?: string;
		width?: 'narrow' | 'default' | 'wide';
		eyebrow?: Snippet;
		actions?: Snippet;
		aside?: Snippet;
		children: Snippet;
	} = $props();
</script>

<div class="frame frame--{width}">
	<header class="head">
		<div class="heading">
			{#if eyebrow}<div class="eyebrow">{@render eyebrow()}</div>{/if}
			<h1 class="title">{title}</h1>
			{#if description}<p class="desc">{description}</p>{/if}
		</div>
		{#if actions}<div class="actions">{@render actions()}</div>{/if}
	</header>
	{#if aside}
		<div class="split">
			<div class="main">{@render children()}</div>
			<aside class="aside">{@render aside()}</aside>
		</div>
	{:else}
		<div class="main">{@render children()}</div>
	{/if}
</div>

<style>
	.frame {
		width: 100%;
		margin: 0 auto;
		padding: 2rem 2rem 4rem;
	}
	.frame--narrow {
		max-width: calc(var(--page-narrow) + 4rem);
	}
	.frame--default {
		max-width: calc(var(--page-default) + 4rem);
	}
	.frame--wide {
		max-width: calc(var(--page-wide) + 4rem);
	}
	.head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}
	.heading {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}
	.eyebrow {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.title {
		font-size: var(--text-title-1);
		line-height: var(--lh-title-1);
		font-weight: var(--weight-semibold);
		letter-spacing: -0.018em;
		color: var(--text-default);
	}
	.desc {
		max-width: 65ch;
		font-size: var(--text-body);
		line-height: var(--lh-body);
		color: var(--text-muted);
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}
	.main {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		min-width: 0;
	}
	.split {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 18rem;
		gap: 2rem;
		align-items: start;
	}
	.aside {
		position: sticky;
		top: 2rem;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		min-width: 0;
	}
	@media (max-width: 1024px) {
		.split {
			grid-template-columns: minmax(0, 1fr);
		}
		.aside {
			position: static;
		}
	}
	@media (max-width: 640px) {
		.frame {
			padding: 1.5rem 1rem 3rem;
		}
		.head {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
