<script lang="ts">
	import { Star, Plus, ArrowRight, ChevronRight, Database as DatabaseIcon } from 'lucide-svelte';
	import { StatusDot, resourceStatus } from '$lib/components/ui';
	import { formatCpu, formatMemory } from '$lib/utils/format';
	import { slide } from '$lib/utils/transitions';
	import { timeAgo, projectSwatch, knownIcon, favUrl, IMG_ICONS } from './helpers.svelte';
	import { motionStagger, springRotate } from '$lib/utils/motion.svelte';
	import type { ProjectGroup, DeploymentSummary, LiveMetricsEntry } from './types';

	let {
		groups,
		favDeps,
		orgSlug,
		liveMetrics,
		failedFav,
		expandedProjects,
		onToggleExpand,
		onFavErr
	}: {
		groups: ProjectGroup[];
		favDeps: DeploymentSummary[];
		orgSlug: string;
		liveMetrics?: ReadonlyMap<string, LiveMetricsEntry>;
		failedFav: Set<string>;
		expandedProjects: Set<string>;
		onToggleExpand: (id: string, e: Event) => void;
		onFavErr: (id: string) => void;
	} = $props();

	function depIcon(dep: DeploymentSummary): string | null {
		const known = knownIcon(dep.image);
		if (known) return known;
		if (failedFav.has(dep.id)) return null;
		if (dep.faviconUrl) return dep.faviconUrl;
		const host = dep.ingresses?.[0]?.host?.split('/')[0];
		return host ? favUrl(host) : null;
	}

	function subtitle(dep: DeploymentSummary): string {
		const host = dep.ingresses?.[0]?.host?.split('/')[0];
		if (host) return host;
		if (dep.githubRepo) {
			const repo = dep.githubRepo.replace(/^https?:\/\/github\.com\//, '');
			return dep.githubBranch ? `${repo} @ ${dep.githubBranch}` : repo;
		}
		return dep.image ?? '';
	}

	function metrics(dep: DeploymentSummary): string | null {
		const m = liveMetrics?.get(dep.id);
		if (!m) return null;
		return `${formatCpu(m.cpuMilli)} · ${formatMemory(m.memoryBytes)}`;
	}
</script>

<div class="cl">
	{#if favDeps.length > 0}
		<section class="cl-group" {@attach motionStagger({ index: 0, from: { y: 8 } })}>
			<div class="cl-head cl-head--static">
				<span class="cl-favstar"><Star size={12} /></span>
				<span class="cl-gname">Favourites</span>
			</div>
			{#each favDeps as dep (dep.id)}
				{@render depRow(dep)}
			{/each}
		</section>
	{/if}

	{#each groups as group, gi (group.id)}
		{@const isOpen = expandedProjects.has(group.id)}
		<section class="cl-group" {@attach motionStagger({ index: gi + 1, from: { y: 8 } })}>
			<div class="cl-headrow">
				<button
					type="button"
					class="cl-head"
					aria-expanded={isOpen}
					onclick={(e) => onToggleExpand(group.id, e)}
				>
					<span class="cl-chevron" {@attach springRotate(() => isOpen, { rest: 0, on: 90 })}>
						<ChevronRight size={13} />
					</span>
					<span class="cl-swatch" style={projectSwatch(group.slug)}></span>
					<span class="cl-gname">{group.name}</span>
					<span class="cl-gcount">{group.deps.length + group.dbs.length}</span>
				</button>
				<a
					class="cl-new"
					href="/{orgSlug}/projects/{group.slug}"
					title="Open {group.name}"
					aria-label="Open {group.name}"
				>
					<ArrowRight size={13} />
				</a>
				<a
					class="cl-new"
					href="/{orgSlug}/new?projectSlug={group.slug}"
					title="New in {group.name}"
					aria-label="New in {group.name}"
				>
					<Plus size={13} />
				</a>
			</div>
			{#if isOpen}
				<div class="cl-rows" transition:slide={{ duration: 140 }}>
					{#each group.deps as dep (dep.id)}
						{@render depRow(dep)}
					{/each}
					{#each group.dbs as db (db.id)}
						<a class="cl-row" href="/{orgSlug}/databases/{db.id}">
							<StatusDot meta={resourceStatus(db.status)} size={6} />
							<img src={IMG_ICONS.postgres} alt="" class="cl-ic" loading="lazy" decoding="async" />
							<span class="cl-name">{db.name}</span>
							<span class="cl-sub"><DatabaseIcon size={10} /> {db.dbName}</span>
							<span class="cl-end">{timeAgo(db.updatedAt)}</span>
						</a>
					{/each}
				</div>
			{/if}
		</section>
	{/each}
</div>

{#snippet depRow(dep: DeploymentSummary)}
	{@const icon = depIcon(dep)}
	<a class="cl-row" href="/{orgSlug}/deployments/{dep.id}">
		<StatusDot meta={resourceStatus(dep.status, dep.buildStatus)} size={6} />
		{#if icon}
			<img
				src={icon}
				alt=""
				class="cl-ic"
				loading="lazy"
				decoding="async"
				onerror={() => onFavErr(dep.id)}
			/>
		{:else}
			<span class="cl-av">{dep.name.charAt(0).toUpperCase()}</span>
		{/if}
		<span class="cl-name">{dep.name}</span>
		<span class="cl-sub">{subtitle(dep)}</span>
		{#if metrics(dep)}
			<span class="cl-metrics">{metrics(dep)}</span>
		{/if}
		<span class="cl-end">{timeAgo(dep.updatedAt)}</span>
	</a>
{/snippet}

<style>
	.cl {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.cl-group {
		display: flex;
		flex-direction: column;
	}

	.cl-headrow {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.cl-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem 0.625rem;
		border-radius: 0.5rem;
		border: none;
		background: none;
		font: inherit;
		text-align: left;
		cursor: pointer;
		text-decoration: none;
		color: inherit;
		min-width: 0;
		flex: 1;
	}

	button.cl-head:hover {
		background-color: var(--bg-hover);
	}

	.cl-chevron {
		display: inline-flex;
		color: var(--text-faint);
		flex-shrink: 0;
	}

	.cl-rows {
		display: flex;
		flex-direction: column;
	}

	.cl-new {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		color: var(--text-faint);
		flex-shrink: 0;
		transition:
			color 120ms ease,
			background-color 120ms ease;
	}

	.cl-new:hover {
		color: var(--text-default);
		background-color: var(--bg-hover);
	}

	.cl-swatch {
		width: 1.125rem;
		height: 1.125rem;
		border-radius: 0.375rem;
		flex-shrink: 0;
	}

	.cl-favstar {
		display: inline-flex;
		color: var(--status-warning);
		flex-shrink: 0;
	}

	.cl-gname {
		font-size: 0.8125rem;
		font-weight: 650;
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.cl-gcount {
		font-size: 0.6875rem;
		color: var(--text-faint);
		font-family: var(--font-mono);
	}

	.cl-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.375rem 0.625rem 0.375rem 2rem;
		border-radius: 0.5rem;
		text-decoration: none;
		color: inherit;
		min-width: 0;
		transition: background-color 120ms ease;
	}

	.cl-row:hover {
		background-color: var(--bg-hover);
	}

	.cl-ic {
		width: 1rem;
		height: 1rem;
		border-radius: 0.25rem;
		object-fit: contain;
		flex-shrink: 0;
	}

	.cl-av {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		border-radius: 0.25rem;
		background-color: var(--bg-hover);
		color: var(--text-muted);
		font-size: 0.5625rem;
		font-weight: 700;
		flex-shrink: 0;
	}

	.cl-name {
		font-size: 0.8125rem;
		font-weight: 550;
		color: var(--text-default);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.cl-sub {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.75rem;
		font-family: var(--font-mono);
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
		flex: 1;
	}

	.cl-metrics {
		font-size: 0.6875rem;
		font-family: var(--font-mono);
		color: var(--text-muted);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.cl-end {
		font-size: 0.6875rem;
		color: var(--text-faint);
		white-space: nowrap;
		flex-shrink: 0;
		margin-left: auto;
	}
</style>
