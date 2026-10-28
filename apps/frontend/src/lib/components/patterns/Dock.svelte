<script lang="ts" module>
	import type { Icon } from '$lib/components/ui/types';

	export type DockTone = 'ink' | 'blue' | 'green' | 'amber' | 'red' | 'accent' | 'paper';

	export type DockItem = {
		id: string;
		label: string;
		hint?: string;
		icon?: Icon;
		image?: string;
		tone?: DockTone;
		href?: string;
		badge?: string;
	};
</script>

<script lang="ts">
	import Spinner from '$lib/components/ui/Spinner.svelte';

	let {
		items,
		label,
		busy = null,
		onSelect = undefined
	}: {
		items: DockItem[];
		label: string;
		busy?: string | null;
		onSelect?: (item: DockItem) => void;
	} = $props();

	function choose(e: MouseEvent, item: DockItem) {
		if (!onSelect || e.metaKey || e.ctrlKey || e.shiftKey) return;
		e.preventDefault();
		onSelect(item);
	}
</script>

<nav class="dock" aria-label={label}>
	{#each items as item (item.id)}
		{@const Glyph = item.icon}
		<a
			class="tile"
			href={item.href ?? '#'}
			aria-busy={busy === item.id || undefined}
			aria-disabled={busy !== null && busy !== item.id ? 'true' : undefined}
			onclick={(e) => choose(e, item)}
		>
			<span class="art art--{item.tone ?? 'paper'}">
				{#if busy === item.id}
					<Spinner size={28} />
				{:else if item.image}
					<img src={item.image} alt="" class="art-img" />
				{:else if Glyph}
					<Glyph size={34} strokeWidth={1.75} />
				{/if}
				{#if item.badge}<span class="badge">{item.badge}</span>{/if}
			</span>
			<span class="text">
				<span class="label">{item.label}</span>
				{#if item.hint}<span class="hint">{item.hint}</span>{/if}
			</span>
		</a>
	{/each}
</nav>

<style>
	.dock {
		--dock-pad: 0.75rem;
		--tile-r: 1.125rem;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
		gap: var(--dock-pad);
		padding: var(--dock-pad);
		border-radius: calc((var(--tile-r) + var(--dock-pad)) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
	}
	.tile {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		padding-bottom: 0.25rem;
		color: inherit;
		text-decoration: none;
		border-radius: calc(var(--tile-r) * var(--corner-scale));
		corner-shape: var(--corner);
		outline: none;
	}
	.tile[aria-disabled='true'] {
		opacity: 0.5;
		pointer-events: none;
	}
	.art {
		position: relative;
		display: grid;
		place-items: center;
		aspect-ratio: 16 / 10;
		border-radius: calc(var(--tile-r) * var(--corner-scale));
		corner-shape: var(--corner);
		box-shadow: inset 0 0 0 0.5px var(--rule);
		transition:
			transform var(--spring-glide-duration) var(--spring-glide),
			box-shadow var(--fade-in) var(--curve-out);
	}
	.tile:hover .art,
	.tile:focus-visible .art {
		transform: translateY(-2px) scale(1.025);
		box-shadow:
			inset 0 0 0 0.5px var(--rule),
			var(--shadow-floating);
	}
	.tile:active .art {
		transform: scale(0.98);
		transition-duration: var(--spring-press-duration);
	}
	.tile:focus-visible .art {
		outline: 2px solid var(--accent-solid);
		outline-offset: 2px;
	}
	.art--ink {
		background: var(--neutral-10);
		color: var(--neutral-app);
	}
	.art--blue {
		background: var(--blue-solid);
		color: var(--on-solid);
	}
	.art--green {
		background: var(--green-solid);
		color: var(--on-solid);
	}
	.art--amber {
		background: var(--amber-solid);
		color: var(--on-solid);
	}
	.art--red {
		background: var(--red-solid);
		color: var(--on-solid);
	}
	.art--accent {
		background: var(--accent-solid);
		color: var(--on-solid);
	}
	.art--paper {
		background: var(--bg-raised);
		color: var(--text-default);
	}
	.art-img {
		width: 2.75rem;
		height: 2.75rem;
		object-fit: contain;
	}
	.badge {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		padding: 0.125rem 0.4375rem;
		border-radius: var(--radius-pill);
		background: var(--on-media-pill);
		color: var(--on-media);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: var(--weight-medium);
	}
	.text {
		display: flex;
		flex-direction: column;
		gap: 0.0625rem;
		padding: 0 0.25rem;
		min-width: 0;
	}
	.label {
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: var(--weight-medium);
	}
	.hint {
		overflow: hidden;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
