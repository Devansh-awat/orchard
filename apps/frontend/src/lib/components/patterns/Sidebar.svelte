<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Search, ChevronsUpDown, ChevronRight, TriangleAlert, PanelLeft } from 'lucide-svelte';
	import NavItem from '$lib/components/ui/NavItem.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import RemoteImg from '$lib/components/ui/RemoteImg.svelte';
	import AuraTile from '$lib/components/ui/AuraTile.svelte';
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
			{#if org.avatar}<RemoteImg src={org.avatar} class="cover" />{:else}{org.name.charAt(0)}{/if}
		</span>
		<span class="org-text">
			<span class="org-name">{org.name}</span>
			{#if org.plan}<span class="org-plan">{org.plan}</span>{/if}
		</span>
		<ChevronsUpDown size={14} class="org-chev" />
	</button>

	<div class="scroll">
		<NavItem label="Search" icon={Search} onclick={onSearch}>
			{#snippet trailing()}<kbd class="kbd">⌘K</kbd>{/snippet}
		</NavItem>

		{#if children}
			{@render children()}
		{:else}
			{#if failing.length > 0}
				<NavItem
					label="Failing"
					icon={TriangleAlert}
					tone="danger"
					count={failing.length}
					onclick={() => (failingOpen = !failingOpen)}
				>
					{#snippet trailing()}
						<span class="chev" {@attach springRotate(() => failingOpen, { rest: 0, on: 90 })}
							><ChevronRight size={14} /></span
						>
					{/snippet}
				</NavItem>
				<div {@attach springCollapse(() => !failingOpen)}>
					<div class="nested">
						{#each failing as f (f.label)}
							<NavItem href={f.href} label={f.label}>
								{#snippet leading()}<StatusDot meta={crashing} size={7} />{/snippet}
							</NavItem>
						{/each}
					</div>
				</div>
			{/if}
			{#each sections as section, si (si)}
				{#if section.label}<p class="section">{section.label}</p>{/if}
				{#each section.items as item (item.label)}
					{#if section.tiles}
						<NavItem href={item.href} label={item.label} active={item.active}>
							{#snippet leading()}
								<span class="app">
									<AuraTile name={item.label} class="app-art">
										<span class="app-letter">{item.label.charAt(0).toUpperCase()}</span>
									</AuraTile>
									{#if item.status}<span class="app-dot"
											><StatusDot meta={item.status} size={7} /></span
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
				{#if user.avatar}<RemoteImg src={user.avatar} class="cover" />{:else}{user.handle
						.charAt(0)
						.toUpperCase()}{/if}
			</span>
			<span class="me-name">@{user.handle}</span>
		</button>
		<button type="button" class="fold" aria-label="Collapse sidebar">
			<PanelLeft size={16} />
		</button>
	</div>
</nav>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		height: 100%;
		padding: 0.5rem;
		border-radius: var(--radius-panel);
		corner-shape: var(--corner);
		background: var(--material-chrome-bg);
		backdrop-filter: var(--material-chrome-filter);
		box-shadow:
			inset 0 0 0 0.5px var(--material-chrome-edge),
			0 1px 2px color-mix(in oklab, var(--neutral-10) 5%, transparent),
			0 16px 40px -16px color-mix(in oklab, var(--neutral-10) 20%, transparent);
		overflow: hidden;
	}
	.org {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 2.75rem;
		padding: 0 0.5rem 0 0.375rem;
		border: none;
		border-radius: 0.6875rem;
		corner-shape: var(--corner);
		background: none;
		color: var(--text-default);
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--dur-fast) ease;
	}
	.org:hover {
		background: color-mix(in oklab, var(--neutral-10) 6%, transparent);
	}
	.org-avatar,
	.me-avatar {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		overflow: hidden;
		border-radius: 0.5rem;
		corner-shape: var(--corner);
		font-weight: var(--weight-semibold);
	}
	.org-avatar {
		width: 2rem;
		height: 2rem;
		background: var(--accent-solid);
		background-image: var(--solid-sheen);
		color: var(--on-solid);
		font-size: var(--text-headline);
		box-shadow: inset 0 0 0 0.5px var(--solid-edge);
	}
	.org-avatar :global(.cover),
	.me-avatar :global(.cover) {
		width: 100%;
		height: 100%;
		object-fit: cover;
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
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.org-name {
		font-size: var(--text-body);
		font-weight: var(--weight-semibold);
	}
	.org-plan {
		color: var(--text-muted);
		font-size: var(--text-caption);
	}
	.org :global(.org-chev) {
		flex-shrink: 0;
		color: var(--text-faint);
	}
	.scroll {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.125rem;
		min-height: 0;
		overflow-y: auto;
		scrollbar-width: none;
	}
	.scroll > :global(*) {
		flex-shrink: 0;
	}
	.kbd {
		padding: 0.1875rem 0.375rem;
		border-radius: 0.375rem;
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--neutral-10) 7%, transparent);
		color: var(--text-muted);
		font-family: inherit;
		font-size: var(--text-micro);
		font-weight: var(--weight-medium);
	}
	.chev {
		display: flex;
		color: var(--text-faint);
	}
	.nested {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		padding: 0.125rem 0 0.25rem 1.5rem;
		--nav-row-h: 2.25rem;
	}
	.section {
		padding: 0.875rem 0.5rem 0.25rem;
		color: var(--text-faint);
		font-size: var(--text-caption);
		font-weight: var(--weight-semibold);
	}
	.app {
		position: relative;
		display: block;
		width: 1.5rem;
		height: 1.5rem;
	}
	.app :global(.app-art) {
		width: 100%;
		height: 100%;
		border-radius: 0.4375rem;
		corner-shape: var(--corner);
		box-shadow: inset 0 0 0 0.5px var(--on-media-edge);
	}
	.app-letter {
		display: grid;
		place-items: center;
		height: 100%;
		color: var(--on-media);
		font-size: var(--text-micro);
		font-weight: var(--weight-semibold);
	}
	.app-dot {
		position: absolute;
		right: -0.125rem;
		bottom: -0.125rem;
		display: flex;
		padding: 2px;
		border-radius: 50%;
		background: var(--bg-surface);
	}
	.foot {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.me {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 0.75rem;
		height: 2.5rem;
		padding: 0 0.375rem;
		border: none;
		border-radius: 0.6875rem;
		corner-shape: var(--corner);
		background: none;
		color: var(--text-default);
		font: inherit;
		cursor: pointer;
	}
	.me:hover,
	.fold:hover {
		background: color-mix(in oklab, var(--neutral-10) 6%, transparent);
	}
	.me-avatar {
		width: 1.5rem;
		height: 1.5rem;
		background: var(--neutral-7);
		color: var(--on-solid);
		font-size: var(--text-caption);
	}
	.me-name {
		font-family: var(--font-mono);
		font-size: var(--text-callout);
		text-box: trim-both cap alphabetic;
	}
	.fold {
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border: none;
		border-radius: 0.6875rem;
		corner-shape: var(--corner);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
	}
</style>
