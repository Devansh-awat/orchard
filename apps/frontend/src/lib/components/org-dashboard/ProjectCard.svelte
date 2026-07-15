<script lang="ts">
	import {
		Plus,
		ChevronRight,
		Folder,
		Rocket,
		Database,
		ArrowRight,
		Github,
		Container,
		Ellipsis
	} from 'lucide-svelte';
	import { motionStagger, springRotate } from '$lib/utils/motion.svelte';
	import { projectGradientEnabled } from '$lib/stores';
	import { projectStatusSummary, meshBakedBg, bodyAttach, knownIcon } from './helpers.svelte';
	import { Menu, MenuItem } from '$lib/components/ui';
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

	const depIcons = $derived.by(() => {
		const icons: { id: string; src: string }[] = [];
		for (const dep of group.deps) {
			if (icons.length >= 3) break;
			const known = knownIcon(dep.image);
			if (known) {
				icons.push({ id: dep.id, src: known });
				continue;
			}
			if (!failedFav.has(dep.id) && dep.faviconUrl) {
				icons.push({ id: dep.id, src: dep.faviconUrl });
			}
		}
		return icons;
	});

	let newOpen = $state(false);

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
	<button
		class="proj-head"
		onclick={(e) => onToggleExpand(group.id, e)}
		aria-expanded={expanded}
		aria-label={expanded ? `Collapse ${group.name}` : `Expand ${group.name}`}
	>
		<div
			class="proj-chev"
			class:proj-chev--open={expanded}
			{@attach springRotate(() => expanded, { rest: 0, on: 90 })}
		>
			<ChevronRight size={16} />
		</div>
		<div
			class="proj-av"
			class:proj-av--fallback={meta?.icon ? !/^https?:\/\//.test(meta.icon) : depIcons.length === 0}
			class:proj-av--cluster={!meta?.icon && depIcons.length > 0}
		>
			{#if meta?.icon}
				{#if /^https?:\/\//.test(meta.icon)}
					<img src={meta.icon} alt="" class="proj-av-img" loading="lazy" decoding="async" />
				{:else}
					<span class="proj-av-emoji">{meta.icon}</span>
				{/if}
			{:else if depIcons.length > 0}
				<div class="proj-av-cluster proj-av-cluster--{depIcons.length}">
					{#each depIcons as ic (ic.id)}
						<img
							src={ic.src}
							alt=""
							class="proj-av-mini"
							decoding="async"
							onerror={() => onFavErr(ic.id)}
						/>
					{/each}
				</div>
			{:else}
				<Folder size={16} />
			{/if}
		</div>
		<div class="proj-text">
			<span class="proj-name"
				>{#if meta?.owner?.username}<span class="proj-owner">{meta.owner.username}@</span
					>{/if}{group.name}</span
			>
			{#if meta?.description}
				<span class="proj-sub">{meta.description}</span>
			{/if}
		</div>
		<div class="proj-stats">
			<span class="proj-stat" title="Deployments"><Rocket size={12} /> {group.deps.length}</span>
			{#if group.dbs.length > 0}
				<span class="proj-stat" title="Databases"><Database size={12} /> {group.dbs.length}</span>
			{/if}
			{#if summary}
				<span class="proj-summary">
					{#if summary.green > 0}<span class="dot status--success"></span>{summary.green}{/if}
					{#if summary.amber > 0}<span class="dot status--warning"></span>{summary.amber}{/if}
					{#if summary.red > 0}<span class="dot status--error"></span>{summary.red}{/if}
				</span>
			{/if}
		</div>
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
	</button>
	{#if rendered}
		<div class="proj-body" {@attach bodyAttachment}>
			<div class="od-grid">
				{#each group.deps as dep, i (dep.id)}
					<div {@attach motionStagger({ index: i, stride: 0.04, from: { y: 8 } })}>
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
						{@attach motionStagger({
							index: group.deps.length + i,
							stride: 0.04,
							from: { y: 8 }
						})}
					>
						<DatabaseCard {db} {orgSlug} />
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
