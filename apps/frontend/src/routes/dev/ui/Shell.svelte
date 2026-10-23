<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		LayoutGrid,
		Database,
		Timer,
		Activity,
		Gauge,
		Settings,
		Search,
		ChevronsUpDown
	} from 'lucide-svelte';
	import NavItem from '$lib/components/ui/NavItem.svelte';
	import Monogram from '$lib/components/ui/Monogram.svelte';
	import Kbd from '$lib/components/ui/Kbd.svelte';

	let {
		active = 'apps',
		nav = undefined,
		children
	}: { active?: string; nav?: Snippet; children: Snippet } = $props();

	const NAV = [
		{ id: 'apps', label: 'Apps', icon: LayoutGrid },
		{ id: 'databases', label: 'Databases', icon: Database },
		{ id: 'jobs', label: 'Jobs', icon: Timer },
		{ id: 'activity', label: 'Activity', icon: Activity },
		{ id: 'usage', label: 'Usage', icon: Gauge },
		{ id: 'settings', label: 'Settings', icon: Settings }
	];

	const PROJECTS = ['hackclub-site', 'arcade-leaderboard', 'summer-of-making', 'bank'];
</script>

<div class="frame">
	<nav class="side" aria-label="Main">
		<button type="button" class="org">
			<Monogram name="Hack Club" />
			<span class="org-name">Hack Club</span>
			<ChevronsUpDown size={14} class="text-faint" />
		</button>

		<button type="button" class="search">
			<Search size={14} />
			<span>Search</span>
			<Kbd keys={['⌘', 'K']} />
		</button>

		{#if nav}
			{@render nav()}
		{:else}
			<div class="group">
				{#each NAV as item (item.id)}
					<NavItem href="#" label={item.label} icon={item.icon} active={item.id === active} />
				{/each}
			</div>

			<div class="group">
				<p class="group-label">Projects</p>
				{#each PROJECTS as name (name)}
					<NavItem href="#" label={name}>
						{#snippet leading()}<Monogram {name} size="sm" />{/snippet}
					</NavItem>
				{/each}
			</div>
		{/if}

		<div class="me">
			<span class="avatar">S</span>
			<span class="me-name">seb</span>
		</div>
	</nav>

	<main class="sheet">{@render children()}</main>
</div>

<style>
	.frame {
		display: grid;
		grid-template-columns: 15rem minmax(0, 1fr);
		height: 100dvh;
		padding: 0.5rem 0.5rem 0.5rem 0;
		background: var(--bg-app);
	}
	.side {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		min-height: 0;
		padding: 0.5rem 0.75rem;
		overflow-y: auto;
	}
	.org {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		height: 2.25rem;
		padding: 0 0.375rem;
		border: none;
		border-radius: var(--radius-control);
		background: none;
		color: var(--text-default);
		font: inherit;
		font-weight: var(--weight-semibold);
		cursor: pointer;
	}
	.org:hover {
		background: color-mix(in oklab, var(--neutral-10) 5%, transparent);
	}
	.org-name {
		flex: 1;
		text-align: left;
	}
	.search {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: 2rem;
		padding: 0 0.375rem 0 0.625rem;
		border: none;
		border-radius: var(--radius-control);
		background: color-mix(in oklab, var(--neutral-10) 5%, transparent);
		color: var(--text-muted);
		font: inherit;
		font-size: var(--text-body);
		cursor: pointer;
	}
	.search span:first-of-type {
		flex: 1;
		text-align: left;
	}
	.group {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.group-label {
		padding: 0 0.625rem 0.25rem;
		color: var(--text-faint);
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
	}
	.me {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		margin-top: auto;
		padding: 0.375rem;
		color: var(--text-default);
		font-size: var(--text-body);
		font-weight: var(--weight-medium);
	}
	.avatar {
		display: grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		background: var(--accent-7);
		color: var(--accent-contrast);
		font-size: var(--text-caption);
		font-weight: var(--weight-semibold);
	}
	.sheet {
		min-width: 0;
		overflow-y: auto;
		border-radius: 0.875rem;
		background: var(--bg-sheet);
		box-shadow:
			0 0 0 0.5px color-mix(in oklab, var(--neutral-10) 10%, transparent),
			0 1px 3px color-mix(in oklab, var(--neutral-10) 6%, transparent),
			0 8px 24px -8px color-mix(in oklab, var(--neutral-10) 8%, transparent);
	}
</style>
