<script lang="ts">
	import {
		Plus,
		ChevronRight,
		Database,
		ArrowRight,
		Github,
		Container,
		Ellipsis
	} from 'lucide-svelte';
	import { originBurst, springRotate, centerOf } from '$lib/utils/motion.svelte';
	import { projectGradientEnabled } from '$lib/stores';
	import {
		projectStatusSummary,
		meshBakedBg,
		bodyAttach,
		knownIcon,
		projectSwatch,
		iconTint,
		timeAgo
	} from './helpers.svelte';
	import { Menu, MenuItem, RemoteImg } from '$lib/components/ui';
	import DeploymentCard from './DeploymentCard.svelte';
	import DatabaseCard from './DatabaseCard.svelte';
	import type { ProjectGroup, ProjectMeta, DeploymentSummary, LiveMetricsEntry } from './types';

	let {
		group,
		meta,
		orgSlug,
		expanded,
		rendered,
		favouriteIds,
		failedFav,
		liveMetrics,
		projectBodyEls,
		getRenderedProjectBodies,
		setRenderedProjectBodies,
		onToggleExpand,
		onToggleFav,
		onRestart,
		onCopyUrl,
		onVisit,
		onFavErr
	}: {
		group: ProjectGroup;
		meta: ProjectMeta | undefined;
		orgSlug: string;
		expanded: boolean;
		rendered: boolean;
		favouriteIds: Set<string>;
		failedFav: Set<string>;
		liveMetrics?: ReadonlyMap<string, LiveMetricsEntry>;
		projectBodyEls: Map<string, HTMLElement>;
		getRenderedProjectBodies: () => Set<string>;
		setRenderedProjectBodies: (s: Set<string>) => void;
		onToggleExpand: (id: string, e: Event) => void;
		onToggleFav: (dep: DeploymentSummary, e: Event) => void;
		onRestart: (dep: DeploymentSummary, e: Event) => void;
		onCopyUrl: (dep: DeploymentSummary, e: Event) => void;
		onVisit: (dep: DeploymentSummary, e: Event) => void;
		onFavErr: (id: string) => void;
	} = $props();

	const summary = $derived(projectStatusSummary(group));
	const isEmpty = $derived(group.deps.length === 0 && group.dbs.length === 0);

	const lastActivity = $derived.by(() => {
		let newest = 0;
		for (const d of group.deps) newest = Math.max(newest, new Date(d.updatedAt).getTime());
		for (const d of group.dbs) newest = Math.max(newest, new Date(d.updatedAt).getTime());
		return newest ? timeAgo(new Date(newest).toISOString()) : '';
	});

	const depIcons = $derived.by(() => {
		const icons: { id: string; src: string; known: boolean }[] = [];
		for (const dep of group.deps) {
			if (icons.length >= 3) break;
			const known = knownIcon(dep.image);
			if (known) {
				icons.push({ id: dep.id, src: known, known: true });
				continue;
			}
			if (!failedFav.has(dep.id) && dep.faviconUrl) {
				icons.push({ id: dep.id, src: dep.faviconUrl, known: false });
			}
		}
		return icons;
	});

	let newOpen = $state(false);
	let avatarEl = $state<HTMLElement | undefined>();

	const tileCount = $derived(group.deps.length + group.dbs.length);
	const burstOrigin = () => (avatarEl ? centerOf(avatarEl) : null);

	// Stable attachment — rebuilding it on every `group` identity change would
	// re-run the mount animation (height 0 → auto) on each overview refetch.
	const bodyAttachment = bodyAttach(
		group.id,
		() => expanded,
		projectBodyEls,
		getRenderedProjectBodies,
		setRenderedProjectBodies
	);
</script>

<div
	class="proj-card"
	class:proj-card--expanded={expanded}
	class:proj-card--hasbg={!!meta?.backgroundImage && $projectGradientEnabled}
>
	{#if meta?.backgroundImage && $projectGradientEnabled}
		<div class="proj-card-backdrop" aria-hidden="true" {@attach meshBakedBg(meta.backgroundImage)}>
			<div class="proj-mesh proj-mesh--1"></div>
			<div class="proj-mesh proj-mesh--2"></div>
			<div class="proj-mesh proj-mesh--3"></div>
			<div class="proj-body-veil"></div>
		</div>
	{/if}
	<svelte:element
		this={isEmpty ? 'div' : 'button'}
		class="proj-head"
		class:proj-head--static={isEmpty}
		onclick={isEmpty ? undefined : (e: Event) => onToggleExpand(group.id, e)}
		aria-expanded={isEmpty ? undefined : expanded}
		aria-label={isEmpty ? undefined : expanded ? `Collapse ${group.name}` : `Expand ${group.name}`}
	>
		<div
			class="proj-chev"
			class:proj-chev--open={expanded}
			class:proj-chev--empty={isEmpty}
			{@attach springRotate(() => expanded, { rest: 0, on: 90 })}
		>
			{#if !isEmpty}
				<ChevronRight size={16} />
			{/if}
		</div>
		<div
			bind:this={avatarEl}
			class="proj-av"
			class:proj-av--fallback={meta?.icon ? !/^https?:\/\//.test(meta.icon) : depIcons.length === 0}
			class:proj-av--cluster={!meta?.icon && depIcons.length > 0}
		>
			{#if meta?.icon}
				{#if /^https?:\/\//.test(meta.icon)}
					<RemoteImg src={meta.icon} class="proj-av-img" style="background: {iconTint(group.id)}" />
				{:else}
					<span class="proj-av-emoji">{meta.icon}</span>
				{/if}
			{:else if depIcons.length > 0}
				<div class="proj-av-cluster proj-av-cluster--{depIcons.length}">
					{#each depIcons as ic (ic.id)}
						<RemoteImg
							src={ic.src}
							class="proj-av-mini"
							style={ic.known ? undefined : `background: ${iconTint(ic.id)}`}
							onerror={() => onFavErr(ic.id)}
						/>
					{/each}
				</div>
			{:else}
				<span class="proj-av-swatch" style={projectSwatch(group.slug)}></span>
			{/if}
		</div>
		<div class="proj-text">
			<p class="proj-name">
				{group.name}
			</p>
			<p class="proj-meta">
				{#if meta?.owner?.username}
					<span class="proj-owner">{meta.owner.username}</span>
					<span class="proj-dot" aria-hidden="true"></span>
				{/if}
				{#if isEmpty}
					<span>Nothing deployed yet</span>
				{:else}
					<span>{group.deps.length} deployment{group.deps.length === 1 ? '' : 's'}</span>
				{/if}
				{#if group.dbs.length > 0}
					<span class="proj-dot" aria-hidden="true"></span>
					<span>{group.dbs.length} database{group.dbs.length === 1 ? '' : 's'}</span>
				{/if}
				{#if lastActivity}
					<span class="proj-dot proj-dot--wide" aria-hidden="true"></span>
					<span class="proj-when">{lastActivity}</span>
				{/if}
			</p>
		</div>
		{#if summary}
			<div class="proj-stats">
				{#if summary.red > 0}
					<span class="proj-pill proj-pill--error">
						<span class="dot status--error"></span>{summary.red}
					</span>
				{/if}
				{#if summary.amber > 0}
					<span class="proj-pill proj-pill--warning">
						<span class="dot status--warning"></span>{summary.amber}
					</span>
				{/if}
				{#if summary.green > 0}
					<span class="proj-pill proj-pill--success">
						<span class="dot status--success"></span>{summary.green}
					</span>
				{/if}
			</div>
		{/if}
		<Menu placement="bottom-end" bind:open={newOpen}>
			{#snippet trigger(attrs, open)}
				<span
					class="proj-new"
					role="button"
					tabindex="0"
					{...attrs}
					onclick={(e: MouseEvent) => {
						e.stopPropagation();
						(attrs as { onclick?: (e: Event) => void }).onclick?.(e);
					}}
					onkeydown={(e: KeyboardEvent) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							e.stopPropagation();
							newOpen = !newOpen;
						}
					}}
					aria-haspopup="menu"
					aria-expanded={open}
					aria-label="Add new to this project"
				>
					<Plus size={12} /> New
				</span>
			{/snippet}
			<MenuItem href="/{orgSlug}/projects/{group.slug}/deployments/new?source=github">
				<Github size={14} /> GitHub repo
			</MenuItem>
			<MenuItem href="/{orgSlug}/projects/{group.slug}/deployments/new?source=image">
				<Container size={14} /> Docker image
			</MenuItem>
			<MenuItem href="/{orgSlug}/projects/{group.slug}/databases/new">
				<Database size={14} /> Database
			</MenuItem>
			<MenuItem href="/{orgSlug}/new?projectSlug={group.slug}">
				<Ellipsis size={14} /> Templates and more
			</MenuItem>
		</Menu>
		<a
			href="/{orgSlug}/projects/{group.slug}"
			class="proj-open"
			onclick={(e) => e.stopPropagation()}
			aria-label="Open project"
		>
			<ArrowRight size={14} />
		</a>
	</svelte:element>
	{#if rendered && !isEmpty}
		<div class="proj-body" {@attach bodyAttachment}>
			<div class="od-grid">
				{#each group.deps as dep, i (dep.id)}
					<div
						{@attach originBurst({
							origin: burstOrigin,
							index: i,
							count: tileCount,
							closing: () => !expanded
						})}
					>
						<DeploymentCard
							{dep}
							isFav={false}
							{orgSlug}
							isFavourite={favouriteIds.has(dep.id)}
							{failedFav}
							{liveMetrics}
							{onToggleFav}
							{onRestart}
							{onCopyUrl}
							{onVisit}
							{onFavErr}
						/>
					</div>
				{/each}
				{#each group.dbs as db, i (db.id)}
					<div
						{@attach originBurst({
							origin: burstOrigin,
							index: group.deps.length + i,
							count: tileCount,
							closing: () => !expanded
						})}
					>
						<DatabaseCard {db} {orgSlug} />
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
