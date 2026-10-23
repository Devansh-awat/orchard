<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ChevronsUpDown, ChevronRight, TriangleAlert, PanelLeft } from 'lucide-svelte';
	import NavItem from '$lib/components/ui/NavItem.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import RemoteImg from '$lib/components/ui/RemoteImg.svelte';
	import { resourceStatus } from '$lib/components/ui/status';
	import type { FailingApp, SidebarSection } from './sidebar';
	import SearchField from '$lib/components/ui/SearchField.svelte';
	import PopoverPanel from '$lib/components/ui/PopoverPanel.svelte';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';

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
		failing?: FailingApp[];
		onSearch?: () => void;
		children?: Snippet;
	} = $props();

	const crashing = resourceStatus('crashing');
	const failingNames = $derived(failing.map((f) => f.label).join(', '));
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

	<SearchField placeholder="Search" shortcut="⌘K" size="sm" onfocus={onSearch} />

	{#if failing.length > 0 && !children}
		<PopoverPanel placement="right-start">
			{#snippet trigger(attrs, open)}
				<button type="button" class="alert" class:alert--open={open} {...attrs}>
					<span class="alert-icon"><TriangleAlert size={14} strokeWidth={2.25} /></span>
					<span class="alert-text">
						<span class="alert-title">{failing.length} failing</span>
						<span class="alert-sub">{failingNames}</span>
					</span>
					<span class="alert-stack">
						{#each failing.slice(0, 3) as f (f.label)}
							<span class="alert-stack-item"
								><AppIcon name={f.label} kind={f.kind} icon={f.icon} size="xs" /></span
							>
						{/each}
					</span>
					<ChevronRight size={14} class="alert-chev" />
				</button>
			{/snippet}
			{#snippet children({ close })}
				<div class="fail">
					<p class="fail-head">Failing now</p>
					{#each failing as f (f.label)}
						<a class="fail-row" href={f.href} onclick={close}>
							<span class="fail-icon">
								<AppIcon name={f.label} kind={f.kind} icon={f.icon} size="sm" />
								<span class="fail-dot"><StatusDot meta={crashing} size={7} /></span>
							</span>
							<span class="fail-text">
								<span class="fail-name">{f.label}</span>
								{#if f.reason}<span class="fail-reason">{f.reason}</span>{/if}
							</span>
							{#if f.at}<span class="fail-when"><RelativeTime date={f.at} /></span>{/if}
						</a>
					{/each}
				</div>
			{/snippet}
		</PopoverPanel>
	{/if}

	<div class="scroll">
		{#if children}
			{@render children()}
		{:else}
			{#each sections as section, si (si)}
				{#if section.label}<p class="section">{section.label}</p>{/if}
				{#each section.items as item (item.label)}
					{#if section.tiles}
						<NavItem href={item.href} label={item.label} active={item.active}>
							{#snippet leading()}
								<span class="app">
									<AppIcon name={item.label} size="sm" />
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
		border-radius: calc(var(--radius-panel) * var(--corner-scale));
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
		border-radius: calc(0.6875rem * var(--corner-scale));
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
		border-radius: calc(0.5rem * var(--corner-scale));
		corner-shape: var(--corner);
		font-weight: var(--weight-semibold);
	}
	.org-avatar {
		width: 2rem;
		height: 2rem;
		background: var(--accent-solid);
		color: var(--on-solid);
		font-size: var(--text-headline);
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
		border-radius: calc(0.6875rem * var(--corner-scale));
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
		border-radius: calc(0.6875rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
	}
	.alert {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		width: 100%;
		min-height: 2.75rem;
		padding: 0.375rem 0.5rem 0.375rem 0.4375rem;
		border: none;
		border-radius: calc(0.6875rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--red-solid) 8%, transparent);
		box-shadow: inset 0 0 0 0.5px color-mix(in oklab, var(--red-solid) 22%, transparent);
		color: var(--text-default);
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--dur-fast) ease;
	}
	.alert:hover,
	.alert--open {
		background: color-mix(in oklab, var(--red-solid) 12%, transparent);
	}
	.alert-icon {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: calc(0.375rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--red-solid);
		color: var(--on-solid);
	}
	.alert-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}
	.alert-title,
	.alert-sub {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.alert-title {
		color: var(--red-9);
		font-size: var(--text-body);
		font-weight: var(--weight-semibold);
	}
	.alert-sub {
		color: var(--text-muted);
		font-size: var(--text-caption);
	}
	.alert-stack {
		display: flex;
		flex-shrink: 0;
	}
	.alert-stack-item {
		display: block;
		margin-left: -0.375rem;
		border-radius: calc(0.375rem * var(--corner-scale));
		corner-shape: var(--corner);
		box-shadow: 0 0 0 2px var(--bg-surface);
	}
	.alert-stack-item:first-child {
		margin-left: 0;
	}
	.alert :global(.alert-chev) {
		flex-shrink: 0;
		color: var(--text-faint);
	}
	.fail {
		display: flex;
		flex-direction: column;
		width: 18rem;
	}
	.fail-head {
		padding: 0.375rem 0.5rem 0.5rem;
		color: var(--text-muted);
		font-size: var(--text-caption);
		font-weight: var(--weight-semibold);
	}
	.fail-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.5rem;
		border-radius: calc(0.5rem * var(--corner-scale));
		corner-shape: var(--corner);
		color: inherit;
		text-decoration: none;
		transition: background-color var(--dur-fast) ease;
	}
	.fail-row:hover {
		background: var(--bg-hover);
	}
	.fail-icon {
		position: relative;
		flex-shrink: 0;
	}
	.fail-dot {
		position: absolute;
		right: -0.1875rem;
		bottom: -0.1875rem;
		display: flex;
		padding: 2px;
		border-radius: 50%;
		background: var(--bg-raised);
	}
	.fail-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}
	.fail-name,
	.fail-reason {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-box: trim-both cap alphabetic;
		padding-block: 0.3em;
		margin-block: -0.3em;
	}
	.fail-name {
		font-size: var(--text-body);
		font-weight: var(--weight-medium);
	}
	.fail-reason {
		color: var(--text-muted);
		font-size: var(--text-caption);
	}
	.fail-when {
		flex-shrink: 0;
		color: var(--text-faint);
		font-size: var(--text-caption);
	}
</style>
