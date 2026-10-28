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
		onSelect = undefined
	}: {
		items: DockItem[];
		label: string;
		columns?: number;
		busy?: string | null;
		onSelect?: (item: DockItem) => void;
	} = $props();

	function choose(e: MouseEvent, item: DockItem) {
		if (!onSelect || e.metaKey || e.ctrlKey || e.shiftKey) return;
		e.preventDefault();
		onSelect(item);
	}
</script>

<nav class="dock" aria-label={label} style:--cols={columns}>
	{#each items as item (item.id)}
		{@const Glyph = item.icon}
		<a
			class="tile"
			href={item.href ?? '#'}
			aria-busy={busy === item.id || undefined}
			aria-disabled={busy !== null && busy !== item.id ? 'true' : undefined}
			onclick={(e) => choose(e, item)}
		>
			<span class="icon icon--{item.tone ?? 'paper'}">
				{#if busy === item.id}
					<Spinner size={28} />
				{:else if item.image}
					<img src={item.image} alt="" />
				{:else if Glyph}
					<Glyph strokeWidth={1.5} />
				{/if}
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
		align-items: center;
		gap: 0.875rem;
		color: inherit;
		text-align: center;
		text-decoration: none;
		outline: none;
	}
	.tile[aria-disabled='true'] {
		opacity: 0.5;
		pointer-events: none;
	}
	.icon {
		position: relative;
		display: grid;
		place-items: center;
		width: 61.8%;
		aspect-ratio: 1;
		isolation: isolate;
		border-radius: 22.37%;
		corner-shape: var(--corner);
		box-shadow:
			inset 0 0 0 0.5px color-mix(in oklab, var(--neutral-10) 10%, transparent),
			0 1px 2px color-mix(in oklab, var(--neutral-10) 8%, transparent),
			0 14px 28px -16px color-mix(in oklab, var(--neutral-10) 40%, transparent);
		transition: transform var(--spring-glide-duration) var(--spring-glide);
	}
	.icon::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: -1;
		border-radius: inherit;
		box-shadow: var(--shadow-floating);
		opacity: 0;
		transition: opacity var(--dur-base) ease;
	}
	.tile:hover .icon,
	.tile:focus-visible .icon {
		transform: scale(1.04);
	}
	.tile:hover .icon::before,
	.tile:focus-visible .icon::before {
		opacity: 1;
	}
	.tile:active .icon {
		transform: scale(1.01);
		transition-duration: var(--spring-press-duration);
		transition-timing-function: var(--spring-press);
	}
	.tile:focus-visible .icon {
		outline: 3px solid var(--focus-ring);
		outline-offset: 3px;
	}
	.icon > :global(svg) {
		width: 40%;
		height: 40%;
	}
	.icon img {
		width: 56%;
		height: 56%;
		object-fit: contain;
	}
	.icon--ink {
		background: var(--neutral-10);
		color: var(--neutral-app);
	}
	.icon--blue {
		background: var(--blue-solid);
		color: var(--on-solid);
	}
	.icon--green {
		background: var(--green-solid);
		color: var(--on-solid);
	}
	.icon--amber {
		background: var(--amber-solid);
		color: var(--on-solid);
	}
	.icon--red {
		background: var(--red-solid);
		color: var(--on-solid);
	}
	.icon--accent {
		background: var(--accent-solid);
		color: var(--on-solid);
	}
	.icon--paper {
		background: var(--bg-raised);
		color: var(--text-default);
	}
	.badge {
		position: absolute;
		top: -0.375rem;
		right: -0.75rem;
	}
	.text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		max-width: 100%;
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
