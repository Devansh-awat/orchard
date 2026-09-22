<script lang="ts">
	import { Star, Plus, ArrowRight, ChevronRight, Database as DatabaseIcon } from 'lucide-svelte';
	import { StatusDot, resourceStatus, RemoteImg } from '$lib/components/ui';
	import { formatCpu, formatMemory } from '$lib/utils/format';
	import { slide } from '$lib/utils/transitions';
	import {
		timeAgo,
		projectSwatch,
		knownIcon,
		favUrl,
		IMG_ICONS,
		projectStatusSummary
	} from './helpers.svelte';
	import { motionStagger, springRotate, springScaleX } from '$lib/utils/motion.svelte';
	import type { ProjectGroup, ProjectMeta, DeploymentSummary, LiveMetricsEntry } from './types';

	let {
		groups,
		metas,
		favDeps,
		orgSlug,
		liveMetrics,
		failedFav,
		expandedProjects,
		onToggleExpand,
		onFavErr
	}: {
		groups: ProjectGroup[];
		metas: ReadonlyMap<string, ProjectMeta>;
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

	// One attachment per project, created once and reused: springScaleX keeps the
	// rule's progress in its own closure, so handing out a fresh one on re-render
	// would restart the line at its finished position instead of drawing it.
	const ruleAttachments = new Map<string, (el: Element) => void>();
	function ruleFor(id: string) {
		let attachment = ruleAttachments.get(id);
		if (!attachment) {
			attachment = springScaleX(() => expandedProjects.has(id));
			ruleAttachments.set(id, attachment);
		}
		return attachment;
	}

	function groupActivity(g: ProjectGroup): string {
		let newest = 0;
		for (const d of g.deps) newest = Math.max(newest, new Date(d.updatedAt).getTime());
		for (const d of g.dbs) newest = Math.max(newest, new Date(d.updatedAt).getTime());
		return newest ? timeAgo(new Date(newest).toISOString()) : '';
	}

	function groupIcons(group: ProjectGroup): { id: string; src: string }[] {
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
		{@const icons = groupIcons(group)}
		{@const projectIcon = metas.get(group.id)?.icon ?? null}
		{@const summary = projectStatusSummary(group)}
		{@const owner = metas.get(group.id)?.owner?.username}
		{@const activity = groupActivity(group)}
		<section
			class="cl-group"
			class:cl-group--open={isOpen}
			{@attach motionStagger({ index: gi + 1, from: { y: 8 } })}
		>
			<div class="cl-headrow">
				<button
					type="button"
					class="cl-head"
					aria-expanded={isOpen}
					onclick={(e) => onToggleExpand(group.id, e)}
				>
					<span class="cl-chevron" {@attach springRotate(() => isOpen, { rest: 0, on: 90 })}>
						<ChevronRight size={14} />
					</span>
					{#if projectIcon && /^https?:\/\//.test(projectIcon)}
						<RemoteImg src={projectIcon} class="cl-icon" />
					{:else if projectIcon}
						<span class="cl-emoji">{projectIcon}</span>
					{:else if icons.length > 0}
						<span class="cl-cluster cl-cluster--{icons.length}">
							{#each icons as ic (ic.id)}
								<RemoteImg src={ic.src} class="cl-mini" onerror={() => onFavErr(ic.id)} />
							{/each}
						</span>
					{:else}
						<span class="cl-swatch" style={projectSwatch(group.slug)}></span>
					{/if}
					<span class="cl-text">
						<span class="cl-gname">{group.name}</span>
						<span class="cl-meta">
							{#if owner}
								<span class="cl-owner">{owner}</span>
								<span class="cl-dot" aria-hidden="true"></span>
							{/if}
							<span>{group.deps.length} deployment{group.deps.length === 1 ? '' : 's'}</span>
							{#if group.dbs.length > 0}
								<span class="cl-dot" aria-hidden="true"></span>
								<span>{group.dbs.length} database{group.dbs.length === 1 ? '' : 's'}</span>
							{/if}
							{#if activity}
								<span class="cl-dot" aria-hidden="true"></span>
								<span>{activity}</span>
							{/if}
						</span>
					</span>
					{#if summary}
						<span class="cl-stats">
							{#if summary.red > 0}
								<span class="cl-pill cl-pill--error">
									<span class="dot status--error"></span>{summary.red}
								</span>
							{/if}
							{#if summary.amber > 0}
								<span class="cl-pill cl-pill--warning">
									<span class="dot status--warning"></span>{summary.amber}
								</span>
							{/if}
							{#if summary.green > 0}
								<span class="cl-pill cl-pill--success">
									<span class="dot status--success"></span>{summary.green}
								</span>
							{/if}
						</span>
					{/if}
				</button>
				<span class="cl-acts">
					<a
						class="cl-new"
						href="/{orgSlug}/new?projectSlug={group.slug}"
						title="New in {group.name}"
						aria-label="New in {group.name}"
					>
						<Plus size={14} />
					</a>
					<a
						class="cl-new"
						href="/{orgSlug}/projects/{group.slug}"
						title="Open {group.name}"
						aria-label="Open {group.name}"
					>
						<ArrowRight size={14} />
					</a>
				</span>
			</div>
			<span class="cl-rule" aria-hidden="true" {@attach ruleFor(group.id)}></span>
			{#if isOpen}
				<div class="cl-rows" transition:slide={{ duration: 140 }}>
					{#each group.deps as dep (dep.id)}
						{@render depRow(dep)}
					{/each}
					{#each group.dbs as db (db.id)}
						<a class="cl-row" href="/{orgSlug}/databases/{db.id}">
							<StatusDot meta={resourceStatus(db.status)} size={6} />
							<RemoteImg src={IMG_ICONS.postgres} class="cl-ic" />
							<span class="cl-name">{db.name}</span>
							<span class="cl-sub"><DatabaseIcon size={11} /> {db.dbName}</span>
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
			<RemoteImg src={icon} class="cl-ic" onerror={() => onFavErr(dep.id)} />
		{:else}
			<span class="cl-av">{(dep.displayName || dep.name).charAt(0).toUpperCase()}</span>
		{/if}
		<span class="cl-name">{dep.displayName || dep.name}</span>
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
		gap: var(--space-1);
	}

	.cl-group {
		display: flex;
		flex-direction: column;
		border-radius: var(--radius-lg);
		background: var(--bg-raised);
		box-shadow: var(--elev-1);
		overflow: hidden;
	}

	.cl-headrow {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		padding-right: var(--space-2);
		transition: background-color var(--dur-fast) ease;
	}

	.cl-headrow:hover {
		background-color: var(--fill-quiet);
	}

	.cl-head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 2.5rem;
		padding: var(--space-1) var(--space-2);
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

	.cl-head--static {
		cursor: default;
		padding-left: var(--space-4);
	}

	.cl-chevron {
		display: inline-flex;
		color: var(--text-faint);
		flex-shrink: 0;
	}

	.cl-headrow:hover .cl-chevron {
		color: var(--text-muted);
	}

	.cl-rule {
		display: block;
		height: 1px;
		background: var(--rule);
		transform-origin: center;
		pointer-events: none;
	}

	.cl-rows {
		display: flex;
		flex-direction: column;
		padding: var(--space-1) var(--space-2) var(--space-2);
		gap: 0;
	}

	.cl-text {
		display: flex;
		flex-direction: column;
		gap: 0.0625rem;
		min-width: 0;
		flex: 1;
	}

	.cl-meta {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.cl-owner {
		color: var(--text-muted);
	}

	.cl-dot {
		width: 2px;
		height: 2px;
		border-radius: var(--radius-pill);
		background: currentColor;
		opacity: 0.6;
		flex-shrink: 0;
	}

	.cl-stats {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
	}

	.cl-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.0625rem 0.375rem;
		border-radius: var(--radius-pill);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-muted);
		background: var(--fill-soft);
	}

	.cl-acts {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		flex-shrink: 0;
		opacity: 0;
		transition: opacity var(--dur-fast) ease;
	}

	.cl-headrow:hover .cl-acts,
	.cl-acts:focus-within {
		opacity: 1;
	}

	.cl-new {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: var(--radius-pill);
		color: var(--text-muted);
		flex-shrink: 0;
		transition:
			color var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}

	.cl-new:hover {
		color: var(--text-default);
		background-color: var(--fill-medium);
	}

	.cl-swatch {
		width: 1.125rem;
		height: 1.125rem;
		border-radius: var(--radius-xs);
		flex-shrink: 0;
	}

	.cl-cluster {
		position: relative;
		width: 1.125rem;
		height: 1.125rem;
		flex-shrink: 0;
	}

	:global(.cl-icon) {
		width: 1.125rem;
		height: 1.125rem;
		flex-shrink: 0;
		object-fit: contain;
		border-radius: var(--radius-xs);
	}

	.cl-emoji {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.125rem;
		height: 1.125rem;
		flex-shrink: 0;
		font-size: var(--text-body);
		line-height: 1;
	}

	:global(.cl-mini) {
		position: absolute;
		width: 0.8125rem;
		height: 0.8125rem;
		object-fit: cover;
		border-radius: var(--radius-xs);
		box-shadow: 0 0 0 1px var(--bg-raised);
	}

	.cl-cluster--1 :global(.cl-mini) {
		position: static;
		width: 100%;
		height: 100%;
		border-radius: var(--radius-xs);
		box-shadow: none;
	}

	.cl-cluster--2 :global(.cl-mini):nth-child(1) {
		top: 0;
		left: 0;
	}

	.cl-cluster--2 :global(.cl-mini):nth-child(2) {
		bottom: 0;
		right: 0;
	}

	.cl-cluster--3 :global(.cl-mini) {
		width: 0.75rem;
		height: 0.75rem;
	}

	.cl-cluster--3 :global(.cl-mini):nth-child(1) {
		top: 0;
		left: 0;
	}

	.cl-cluster--3 :global(.cl-mini):nth-child(2) {
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
	}

	.cl-cluster--3 :global(.cl-mini):nth-child(3) {
		bottom: 0;
		right: 0;
	}

	.cl-favstar {
		display: inline-flex;
		color: var(--status-warning);
		flex-shrink: 0;
	}

	.cl-gname {
		font-size: var(--text-callout);
		line-height: var(--lh-body);
		font-weight: 600;
		letter-spacing: var(--track-headline);
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.cl-gcount {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.5rem;
		border-radius: var(--radius-pill);
		background-color: var(--fill-soft);
		font-size: var(--text-caption);
		font-weight: 600;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.cl-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		height: 1.875rem;
		padding: 0 var(--space-2);
		margin: 0;
		border-radius: var(--radius-sm);
		text-decoration: none;
		color: inherit;
		min-width: 0;
		overflow: hidden;
		transition: background-color var(--dur-fast) ease;
	}

	.cl-row:hover {
		background-color: var(--fill-soft);
	}

	:global(.cl-ic) {
		width: 1rem;
		height: 1rem;
		border-radius: var(--radius-xs);
		object-fit: contain;
		flex-shrink: 0;
	}

	.cl-av {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		border-radius: var(--radius-xs);
		background-color: var(--fill-medium);
		color: var(--text-muted);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 700;
		flex-shrink: 0;
	}

	.cl-name {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		letter-spacing: var(--track-body);
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex-shrink: 1;
		min-width: 0;
	}

	/* Block rather than a flex row so the host truncates instead of running past
	   the card; the database rows put a glyph in here, which inlines alongside. */
	.cl-sub {
		display: block;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-family: var(--font-mono);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
		flex: 1;
	}

	.cl-sub :global(svg) {
		display: inline;
		vertical-align: -0.1em;
	}

	.cl-metrics {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-family: var(--font-mono);
		color: var(--text-faint);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.cl-end {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		flex-shrink: 0;
		margin-left: auto;
		padding-left: var(--space-2);
	}
</style>
