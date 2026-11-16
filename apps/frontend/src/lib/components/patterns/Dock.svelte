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
	import Badge from '$lib/components/ui/Badge.svelte';

	let {
		items,
		label,
		columns = 4,
		busy = null,
		wrapHints = false,
		onSelect = undefined
	}: {
		items: DockItem[];
		label: string;
		columns?: number;
		busy?: string | null;
		wrapHints?: boolean;
		onSelect?: (item: DockItem) => void;
	} = $props();

	function choose(e: MouseEvent, item: DockItem) {
		if (!onSelect || e.metaKey || e.ctrlKey || e.shiftKey) return;
		e.preventDefault();
		onSelect(item);
	}
</script>

<nav class="dock" class:dock--wrap-hints={wrapHints} aria-label={label} style:--cols={columns}>
	{#each items as item (item.id)}
		{@const Glyph = item.icon}
		<a
			class="tile"
			href={item.href ?? '#'}
			aria-busy={busy === item.id || undefined}
			aria-disabled={busy !== null && busy !== item.id ? 'true' : undefined}
			onclick={(e) => choose(e, item)}
		>
			<span class="art">
				<span class="glyph glyph--{item.tone ?? 'paper'}">
					{#if busy === item.id}
						<Spinner size={22} />
					{:else if item.image}
						<img src={item.image} alt="" />
					{:else if Glyph}
						<Glyph size={26} strokeWidth={1.75} />
					{/if}
				</span>
				{#if item.badge}<span class="badge"><Badge tone="accent">{item.badge}</Badge></span>{/if}
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
		--gap: 1rem;
		display: grid;
		grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
		gap: var(--gap);
	}
	@media (max-width: 52rem) {
		.dock {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	.tile {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		color: inherit;
		text-decoration: none;
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
		aspect-ratio: 1.618;
		isolation: isolate;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow:
			inset 0 0 0 0.5px color-mix(in oklab, var(--neutral-10) 12%, transparent),
			0 1px 2px color-mix(in oklab, var(--neutral-10) 5%, transparent);
		transition: transform var(--spring-glide-duration) var(--spring-glide);
	}
	.art::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: -1;
		border-radius: inherit;
		box-shadow: var(--shadow-floating);
		opacity: 0;
		transition: opacity var(--dur-base) ease;
	}
	.tile:hover .art,
	.tile:focus-visible .art {
		transform: scale(1.03);
	}
	.tile:hover .art::before,
	.tile:focus-visible .art::before {
		opacity: 1;
	}
	.tile:active .art {
		transform: scale(1.01);
		transition-duration: var(--spring-press-duration);
		transition-timing-function: var(--spring-press);
	}
	.tile:focus-visible .art {
		box-shadow:
			inset 0 0 0 0.5px color-mix(in oklab, var(--neutral-10) 12%, transparent),
			0 0 0 3px var(--focus-ring);
	}
	.glyph {
		display: grid;
		place-items: center;
		width: 3.5rem;
		height: 3.5rem;
		border-radius: calc(0.875rem * var(--corner-scale));
		corner-shape: var(--corner);
		box-shadow:
			0 6px 14px -6px color-mix(in oklab, var(--neutral-10) 30%, transparent),
			inset 0 0 0 0.5px color-mix(in oklab, var(--neutral-10) 10%, transparent);
	}
	.glyph img {
		width: 2.25rem;
		height: 2.25rem;
		object-fit: contain;
	}
	.glyph--ink {
		background: var(--neutral-10);
		color: var(--neutral-app);
	}
	.glyph--blue {
		background: var(--blue-solid);
		color: var(--on-solid);
	}
	.glyph--green {
		background: var(--green-solid);
		color: var(--on-solid);
	}
	.glyph--amber {
		background: var(--amber-solid);
		color: var(--on-solid);
	}
	.glyph--red {
		background: var(--red-solid);
		color: var(--on-solid);
	}
	.glyph--accent {
		background: var(--accent-solid);
		color: var(--on-solid);
	}
	.glyph--paper {
		background: var(--bg-raised);
		color: var(--text-default);
	}
	.badge {
		position: absolute;
		top: 0.625rem;
		right: 0.625rem;
	}
	.text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
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
	.dock--wrap-hints .hint {
		white-space: normal;
	}
</style>
