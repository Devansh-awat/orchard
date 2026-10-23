<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Search, ChevronDown, ChevronRight, TriangleAlert, PanelLeft } from 'lucide-svelte';
	import NavItem from '$lib/components/ui/NavItem.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import RemoteImg from '$lib/components/ui/RemoteImg.svelte';
	import { resourceStatus } from '$lib/components/ui/status';
	import type { SidebarSection } from './sidebar';
	import { springRotate, springCollapse } from '$lib/utils/motion.svelte';

	let {
		org,
		user,
		sections = [],
		failing = [],
		onSearch = undefined,
		children = undefined
	}: {
		org: { name: string; plan?: string; avatar?: string | null };
		user: { handle: string; avatar?: string | null };
		sections?: SidebarSection[];
		failing?: { label: string; href: string }[];
		onSearch?: () => void;
		children?: Snippet;
	} = $props();

	let failingOpen = $state(false);
	const crashing = resourceStatus('crashing');
</script>

<nav class="panel" aria-label="Main">
	<button type="button" class="org">
		<span class="org-avatar">
			{#if org.avatar}<RemoteImg src={org.avatar} class="org-img" />{:else}{org.name.charAt(0)}{/if}
		</span>
		<span class="org-text">
			<span class="org-name">{org.name}</span>
			{#if org.plan}<span class="org-plan">{org.plan}</span>{/if}
		</span>
		<ChevronDown size={15} class="org-chev" />
	</button>

	<button type="button" class="search" onclick={onSearch}>
		<Search size={15} />
		<span class="search-label">Search</span>
		<kbd class="kbd">⌘K</kbd>
	</button>

	<div class="scroll">
		{#if children}
			{@render children()}
		{:else}
			{#if failing.length > 0}
				<button
					type="button"
					class="strip"
					aria-expanded={failingOpen}
					onclick={() => (failingOpen = !failingOpen)}
				>
					<span class="strip-icon"><TriangleAlert size={15} /></span>
					<span class="strip-label">Failing</span>
					<span class="strip-count">{failing.length}</span>
					<span class="strip-chev" {@attach springRotate(() => failingOpen, { rest: 0, on: 90 })}
						><ChevronRight size={14} /></span
					>
				</button>
				<div {@attach springCollapse(() => !failingOpen)}>
					<div class="strip-body">
						{#each failing as f (f.label)}
							<NavItem href={f.href} label={f.label}>
								{#snippet leading()}<StatusDot meta={crashing} size={7} />{/snippet}
							</NavItem>
						{/each}
					</div>
				</div>
			{/if}
			{#each sections as section, si (si)}
				{#if section.label}<p
						class="section"
						class:section--first={si === 0 && failing.length === 0}
					>
						{section.label}
					</p>{/if}
				{#each section.items as item (item.label)}
					{#if section.tiles}
						<NavItem href={item.href} label={item.label} active={item.active}>
							{#snippet leading()}
								<span class="pin-tile">
									{item.label.charAt(0).toUpperCase()}
									{#if item.status}<span class="pin-dot"
											><StatusDot meta={item.status} size={6} /></span
										>{/if}
								</span>
							{/snippet}
						</NavItem>
					{:else}
						<NavItem href={item.href} label={item.label} icon={item.icon} active={item.active} />
					{/if}
				{/each}
			{/each}
		{/if}
	</div>

	<div class="foot">
		<button type="button" class="me">
			<span class="me-avatar">
				{#if user.avatar}<RemoteImg src={user.avatar} class="org-img" />{:else}{user.handle
						.charAt(0)
						.toUpperCase()}{/if}
			</span>
			<span class="me-name">@{user.handle}</span>
		</button>
		<button type="button" class="fold" aria-label="Collapse sidebar">
			<PanelLeft size={15} />
		</button>
	</div>
</nav>

<style>
	.panel {
		overflow: hidden;
		--nav-active-bg: var(--bg-active);
		--nav-active-shadow: none;
		--nav-row-h: 2.25rem;
		display: flex;
		flex-direction: column;
		height: 100%;
		padding: 0.5rem;
		border-radius: 1.125rem;
		background: var(--bg-sheet);
		box-shadow:
			0 0 0 0.5px color-mix(in oklab, var(--neutral-10) 10%, transparent),
			0 1px 3px color-mix(in oklab, var(--neutral-10) 6%, transparent);
	}
	.org {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem;
		border: none;
		border-radius: 0.625rem;
		background: none;
		color: var(--text-default);
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--dur-fast) ease;
	}
	.org:hover {
		background: var(--bg-hover);
	}
	.org-avatar {
		overflow: hidden;
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.625rem;
		background: linear-gradient(135deg, var(--accent-4), var(--accent-2));
		color: var(--accent-9);
		font-size: var(--text-headline);
		font-weight: var(--weight-semibold);
		box-shadow: inset 0 0 0 0.5px var(--accent-5);
	}
	.org-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}
	.org-name,
	.org-plan {
		text-box: trim-both cap alphabetic;
		white-space: nowrap;
	}
	.org-name {
		font-size: var(--text-body);
		font-weight: var(--weight-semibold);
	}
	.org-plan {
		color: var(--text-faint);
		font-size: var(--text-micro);
		font-weight: var(--weight-semibold);
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.org :global(.org-chev) {
		flex-shrink: 0;
		color: var(--text-faint);
	}
	.search {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: 2.25rem;
		margin: 0.5rem 0 0.75rem;
		padding: 0 0.375rem 0 0.75rem;
		border: none;
		border-radius: 0.625rem;
		background: var(--bg-sunken);
		box-shadow: inset 0 0 0 1px var(--border-default);
		color: var(--text-muted);
		font: inherit;
		font-size: var(--text-callout);
		cursor: pointer;
		transition: background-color var(--dur-fast) ease;
	}
	.search:hover {
		background: var(--bg-hover);
	}
	.search-label {
		flex: 1;
		text-align: left;
		text-box: trim-both cap alphabetic;
	}
	.kbd {
		padding: 0.1875rem 0.375rem;
		border-radius: 0.375rem;
		background: var(--bg-surface);
		box-shadow: inset 0 0 0 0.5px var(--border-strong);
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: var(--text-micro);
	}
	.scroll {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.125rem;
		min-height: 0;
		overflow-y: auto;
	}
	.scroll > :global(*) {
		flex-shrink: 0;
	}
	.strip {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		height: 2.25rem;
		padding: 0 0.5rem 0 0.375rem;
		border: none;
		border-radius: var(--radius-control);
		background: none;
		color: var(--text-default);
		font: inherit;
		font-size: var(--text-body);
		font-weight: var(--weight-medium);
		cursor: pointer;
		transition: background-color var(--dur-fast) ease;
	}
	.strip:hover {
		background: var(--bg-hover);
	}
	.strip-icon {
		display: grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		background: var(--red-2);
		color: var(--status-error);
	}
	.strip-label {
		flex: 1;
		text-align: left;
		text-box: trim-both cap alphabetic;
	}
	.strip-count {
		display: grid;
		place-items: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.375rem;
		border-radius: var(--radius-pill);
		background: var(--red-3);
		color: var(--red-9);
		font-size: var(--text-caption);
		font-weight: var(--weight-semibold);
		font-variant-numeric: tabular-nums;
	}
	.strip-chev {
		display: flex;
		color: var(--text-faint);
	}
	.strip-body {
		padding: 0.125rem 0 0.25rem 1.25rem;
	}
	.section {
		padding: 1rem 0.625rem 0.375rem;
		color: var(--text-faint);
		font-size: var(--text-caption);
		font-weight: var(--weight-semibold);
	}
	.section--spaced {
		padding-top: 1.25rem;
	}
	.pin-tile {
		position: relative;
		display: grid;
		place-items: center;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 0.3125rem;
		background: var(--bg-active);
		color: var(--text-muted);
		font-size: 0.625rem;
		font-weight: var(--weight-semibold);
	}
	.pin-dot {
		position: absolute;
		right: -0.25rem;
		bottom: -0.25rem;
		display: flex;
		padding: 1.5px;
		border-radius: 50%;
		background: var(--bg-sheet);
	}
	.foot {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding-top: 0.5rem;
		box-shadow: inset 0 1px 0 var(--border-default);
	}
	.me {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 0.625rem;
		height: 2.5rem;
		padding: 0 0.375rem;
		border: none;
		border-radius: var(--radius-control);
		background: none;
		color: var(--text-default);
		font: inherit;
		cursor: pointer;
	}
	.me:hover,
	.fold:hover {
		background: var(--bg-hover);
	}
	.me-avatar {
		overflow: hidden;
		display: grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 50%;
		background: var(--accent-7);
		color: var(--accent-contrast);
		font-size: var(--text-caption);
		font-weight: var(--weight-semibold);
	}
	.me-name {
		font-family: var(--font-mono);
		font-size: var(--text-callout);
		text-box: trim-both cap alphabetic;
	}
	.fold {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border: none;
		border-radius: var(--radius-control);
		background: none;
		color: var(--text-faint);
		cursor: pointer;
	}
	.org-avatar :global(.org-img),
	.me-avatar :global(.org-img) {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.section--first {
		padding-top: 0.25rem;
	}
</style>
