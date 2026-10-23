<script lang="ts">
	interface RailItem {
		id: string;
		label: string;
		href: string;
	}

	let {
		groups,
		activeId,
		label = 'Settings sections'
	}: {
		groups: { label: string; items: RailItem[] }[];
		activeId: string;
		label?: string;
	} = $props();

	let railEl = $state<HTMLElement | undefined>(undefined);
	let lastScrolled: string | null = null;

	$effect(() => {
		const id = activeId;
		const el = railEl;
		if (!el || lastScrolled === id) return;
		lastScrolled = id;
		if (getComputedStyle(el).flexDirection !== 'row') return;
		el.querySelector(`[data-rail-id="${id}"]`)?.scrollIntoView({
			block: 'nearest',
			inline: 'nearest'
		});
	});
</script>

<nav class="ui-rail" aria-label={label} bind:this={railEl}>
	{#each groups as group (group.label)}
		<div class="ui-rail-group">
			<p class="ui-rail-eyebrow">{group.label}</p>
			{#each group.items as item (item.id)}
				<a
					href={item.href}
					data-rail-id={item.id}
					class="ui-rail-link"
					class:ui-rail-link--active={activeId === item.id}
					aria-current={activeId === item.id ? 'page' : undefined}
				>
					{item.label}
				</a>
			{/each}
		</div>
	{/each}
</nav>

<style>
	.ui-rail {
		position: sticky;
		top: var(--space-2);
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}
	.ui-rail-group {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.ui-rail-eyebrow {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		letter-spacing: var(--track-body);
		color: var(--text-faint);
		margin: 0 0 0.25rem;
		padding-left: var(--space-2);
	}
	.ui-rail-link {
		display: flex;
		align-items: center;
		height: 2rem;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		letter-spacing: var(--track-body);
		color: var(--text-muted);
		text-decoration: none;
		border-radius: var(--radius-sm);
		corner-shape: var(--corner);
		padding: 0 var(--space-2);
		transition:
			color var(--dur-fast),
			background-color var(--dur-fast);
	}
	.ui-rail-link:hover {
		color: var(--text-default);
		background-color: var(--fill-soft);
	}
	.ui-rail-link--active {
		color: var(--text-default);
		background-color: var(--fill-medium);
	}
	@media (max-width: 900px) {
		.ui-rail {
			position: static;
			flex-direction: row;
			overflow-x: auto;
			gap: var(--space-4);
			padding-bottom: 0.25rem;
			scrollbar-width: none;
		}
		.ui-rail::-webkit-scrollbar {
			display: none;
		}
		.ui-rail-group {
			flex-direction: row;
			align-items: center;
			gap: 0.125rem;
			flex-shrink: 0;
		}
		.ui-rail-eyebrow {
			display: none;
		}
		.ui-rail-link {
			white-space: nowrap;
		}
	}
</style>
