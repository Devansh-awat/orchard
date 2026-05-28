<script lang="ts">
	import {
		Plus,
		ChevronRight,
		Folder,
		Rocket,
		Database,
		ArrowRight
	} from 'lucide-svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import {
		projectStatusSummary,
		preBlurBg,
		springRotate,
		bodyAttach
	} from './helpers.svelte';
	import DeploymentCard from './DeploymentCard.svelte';
	import DatabaseCard from './DatabaseCard.svelte';
	import type { ProjectGroup, ProjectMeta, DeploymentSummary } from './types';

	let {
		group,
		meta,
		orgSlug,
		expanded,
		rendered,
		favouriteIds,
		failedFav,
		openMenuId,
		renderMenuId,
		projectBodyEls,
		getRenderedProjectBodies,
		setRenderedProjectBodies,
		onToggleExpand,
		onToggleFav,
		onToggleMenu,
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
		openMenuId: string | null;
		renderMenuId: string | null;
		projectBodyEls: Map<string, HTMLElement>;
		getRenderedProjectBodies: () => Set<string>;
		setRenderedProjectBodies: (s: Set<string>) => void;
		onToggleExpand: (id: string, e: Event) => void;
		onToggleFav: (dep: DeploymentSummary, e: Event) => void;
		onToggleMenu: (id: string, e: Event) => void;
		onRestart: (dep: DeploymentSummary, e: Event) => void;
		onCopyUrl: (dep: DeploymentSummary, e: Event) => void;
		onVisit: (dep: DeploymentSummary, e: Event) => void;
		onFavErr: (id: string) => void;
	} = $props();

	const summary = $derived(projectStatusSummary(group));
</script>

<div
	class="proj-card"
	class:proj-card--expanded={expanded}
	class:proj-card--hasbg={!!meta?.backgroundImage}
>
	{#if meta?.backgroundImage}
		<div class="proj-card-backdrop" aria-hidden="true">
			<div
				class="proj-body-bg proj-body-bg--1"
				{@attach preBlurBg(meta.backgroundImage)}
			></div>
			<div
				class="proj-body-bg proj-body-bg--2"
				{@attach preBlurBg(meta.backgroundImage)}
			></div>
			<div
				class="proj-body-bg proj-body-bg--3"
				{@attach preBlurBg(meta.backgroundImage)}
			></div>
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
			class:proj-av--fallback={!meta?.icon || !/^https?:\/\//.test(meta.icon)}
		>
			{#if meta?.icon}
				{#if /^https?:\/\//.test(meta.icon)}
					<img src={meta.icon} alt="" class="proj-av-img" />
				{:else}
					<span class="proj-av-emoji">{meta.icon}</span>
				{/if}
			{:else}
				<Folder size={16} />
			{/if}
		</div>
		<div class="proj-text">
			<span class="proj-name"
				>{#if meta?.owner?.username}<span class="proj-owner"
						>{meta.owner.username}@</span
					>{/if}{group.name}</span
			>
			{#if meta?.description}
				<span class="proj-sub">{meta.description}</span>
			{/if}
		</div>
		<div class="proj-stats">
			<span class="proj-stat" title="Deployments"
				><Rocket size={12} /> {group.deps.length}</span
			>
			{#if group.dbs.length > 0}
				<span class="proj-stat" title="Databases"
					><Database size={12} /> {group.dbs.length}</span
				>
			{/if}
			{#if summary}
				<span class="proj-summary">
					{#if summary.green > 0}<span class="dot dot--green"
						></span>{summary.green}{/if}
					{#if summary.amber > 0}<span class="dot dot--amber"
						></span>{summary.amber}{/if}
					{#if summary.red > 0}<span class="dot dot--red"></span>{summary.red}{/if}
				</span>
			{/if}
		</div>
		<a
			href="/{orgSlug}/new?projectSlug={group.slug}"
			class="proj-new"
			onclick={(e) => e.stopPropagation()}
			aria-label="Add new to this project"
		>
			<Plus size={12} /> New
		</a>
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
		<div
			class="proj-body"
			{@attach bodyAttach(
				group.id,
				() => expanded,
				projectBodyEls,
				getRenderedProjectBodies,
				setRenderedProjectBodies
			)}
		>
			<div class="od-grid">
				{#each group.deps as dep, i (dep.id)}
					<div {@attach motionStagger({ index: i, stride: 0.04, from: { y: 8 } })}>
						<DeploymentCard
							{dep}
							isFav={false}
							{orgSlug}
							isFavourite={favouriteIds.has(dep.id)}
							{failedFav}
							{openMenuId}
							{renderMenuId}
							{onToggleFav}
							{onToggleMenu}
							{onRestart}
							onCopyUrl={onCopyUrl}
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
