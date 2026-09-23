<script lang="ts">
	import {
		Loader2,
		GitCommit,
		RotateCcw,
		ArrowDown,
		Box,
		Bug,
		Settings2,
		CircleX
	} from 'lucide-svelte';
	import { History, RefreshCw, Terminal } from '@jis3r/icons';
	import { createInfiniteQuery } from '@tanstack/svelte-query';
	import { queryClient } from '$lib/query';
	import { apiFetch, selectedOrganization, subscribeOrgEvents } from '$lib/stores';
	import { motionStagger, stateEcho } from '$lib/utils/motion.svelte';
	import { formatBuildDurationBetween } from '$lib/utils/format';
	import {
		SectionCard,
		StatusBadge,
		statusMeta,
		Button,
		EmptyState,
		SegmentedControl,
		Skeleton,
		Avatar,
		ActivityRow,
		ActivityGroup,
		ToneTile,
		IconTile,
		type StatusKind
	} from '$lib/components/ui';
	import type { Deployment } from '$lib/types/deployment';
	import { knownIcon, favUrl, iconTint } from '$lib/components/org-dashboard/helpers.svelte';
	import ReleaseCard from './ReleaseCard.svelte';
	import {
		DEFAULT_FILTER,
		TIMELINE_FILTERS,
		collapsePodRuns,
		actorLabel,
		entryBadge,
		filterKinds,
		flattenPages,
		groupEntries,
		granularityFor,
		newestAt,
		newlyArrived,
		releaseEnds,
		seedFromImageHistory,
		type DisplayEntry,
		type TimelineFilter,
		type TimelinePage
	} from './timeline-rows';

	let {
		deployment,
		rebuilding,
		rollingBackId = null,
		onRebuild,
		onOpenLogModal,
		onRollback,
		onViewBuildLogs
	}: {
		deployment: Deployment;
		rebuilding: boolean;
		rollingBackId?: string | null;
		onRebuild: () => void;
		onOpenLogModal: (historyId: string) => void;
		onRollback: (historyId: string) => void;
		onViewBuildLogs: () => void;
	} = $props();

	const PAGE_SIZE = 40;

	const isBuilding = $derived(
		deployment.buildStatus === 'building' ||
			deployment.buildStatus === 'queued' ||
			deployment.buildStatus === 'pending'
	);

	let filter = $state<TimelineFilter>(DEFAULT_FILTER);

	const seed = $derived(seedFromImageHistory(deployment.imageHistory, deployment.githubRepo));
	const appIcon = $derived(knownIcon(deployment.image));
	const appHost = $derived(deployment.ingresses?.[0]?.host?.split('/')[0] ?? null);
	let favFailed = $state(false);
	const appSrc = $derived(appIcon ?? (appHost && !favFailed ? favUrl(appHost) : null));
	const ends = $derived(releaseEnds(seed.entries));

	const timeline = createInfiniteQuery(() => ({
		queryKey: ['timeline', deployment.id, filter],
		queryFn: async ({ pageParam }: { pageParam: string | null }) => {
			const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
			const kinds = filterKinds(filter);
			if (kinds) params.set('kinds', kinds);
			if (pageParam) params.set('cursor', pageParam);
			const res = await apiFetch(`/apiv1/observe/deployments/${deployment.id}/timeline?${params}`);
			if (!res.ok) throw new Error(`timeline ${res.status}`);
			return (await res.json()) as TimelinePage;
		},
		initialPageParam: null as string | null,
		getNextPageParam: (last: TimelinePage) => last.nextCursor,
		enabled: !!deployment.id,
		placeholderData:
			filter === 'all' || filter === 'deploys' ? { pages: [seed], pageParams: [null] } : undefined,
		refetchInterval: 60_000,
		refetchIntervalInBackground: false
	}));

	const entries = $derived(flattenPages(timeline.data?.pages));
	const rows = $derived(collapsePodRuns(entries));
	const groups = $derived(groupEntries(rows, granularityFor(filter)));
	const rowIndex = $derived(new Map(rows.map((r, i) => [r.id, i])));
	const loading = $derived(timeline.isPending && !timeline.data);

	const freshIds = new Set<string>();
	let seenIds: Set<string> | null = null;
	let seenNewestAt = 0;
	let seenFilter: TimelineFilter | null = null;
	let staggerOnMount = true;

	function entranceFor(id: string) {
		if (!staggerOnMount || freshIds.has(id)) return undefined;
		return motionStagger({ index: rowIndex.get(id) ?? 0, from: { y: 10 } });
	}

	$effect.pre(() => {
		if (filter !== seenFilter) {
			seenFilter = filter;
			seenIds = null;
			seenNewestAt = 0;
		}
		if (timeline.isPlaceholderData || !timeline.data) return;
		const current = entries;
		if (seenIds === null) {
			seenIds = new Set(current.map((e) => e.id));
			seenNewestAt = newestAt(current);
			return;
		}
		const arrived = newlyArrived(seenIds, current, seenNewestAt);
		for (const id of arrived) {
			seenIds.add(id);
			freshIds.add(id);
		}
		seenNewestAt = Math.max(seenNewestAt, newestAt(current));
	});

	$effect(() => {
		if (rows.length > 0) staggerOnMount = false;
	});

	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	function refreshSoon() {
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			queryClient.invalidateQueries({ queryKey: ['timeline', deployment.id] });
		}, 400);
	}

	$effect(() => {
		const orgId = $selectedOrganization?.id ?? null;
		if (!orgId) return;
		return subscribeOrgEvents(orgId, (ev) => {
			if (ev.id !== deployment.id) return;
			if (
				ev.type === 'build.changed' ||
				ev.type === 'pod.changed' ||
				ev.type === 'deployment.changed'
			) {
				refreshSoon();
			}
		});
	});

	function str(v: unknown): string | null {
		return typeof v === 'string' && v ? v : null;
	}

	function tileTone(entry: DisplayEntry): StatusKind {
		if (entry.kind === 'release') return 'success';
		if (entry.kind === 'build') return entry.meta.buildStatus === 'failed' ? 'error' : 'neutral';
		if (entry.kind === 'pod') return entry.status === 'error' ? 'error' : 'info';
		if (entry.kind === 'audit') return 'warning';
		return entry.status ?? 'neutral';
	}

	function clockLabel(at: string, granularity: 'day' | 'month'): string {
		const d = new Date(at);
		if (granularity === 'month')
			return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
		return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	function podDetail(entry: DisplayEntry): string | null {
		const name = str(entry.meta.podName);
		if (!entry.detail || !name) return entry.detail;
		const rest = entry.detail.replace(name, '').replace(/^\s*·\s*/, '');
		return rest || null;
	}

	function emptyCopy(f: TimelineFilter): { title: string; description: string } {
		if (f === 'deploys' || f === 'all') {
			return {
				title: 'No deploys yet',
				description: deployment.githubRepo
					? `Push to ${deployment.githubBranch || 'main'} or hit Redeploy to ship the first one.`
					: 'The first deploy will show up here.'
			};
		}
		if (f === 'changes') {
			return {
				title: 'No changes yet',
				description: 'Settings edits and actions by people land here.'
			};
		}
		if (f === 'pods') {
			return {
				title: 'No pod events yet',
				description: 'Pods starting, stopping and crashing land here.'
			};
		}
		return {
			title: 'No errors seen',
			description: 'New error groups from the app logs land here.'
		};
	}
</script>

<div class="tl">
	<ReleaseCard
		live={ends.live}
		previous={ends.previous}
		{deployment}
		{rollingBackId}
		{onRollback}
		{onOpenLogModal}
		{onViewBuildLogs}
	/>

	<SectionCard>
		<div class="tl-head">
			<SegmentedControl
				options={TIMELINE_FILTERS}
				value={filter}
				label="Show"
				onchange={(v) => (filter = v as TimelineFilter)}
			/>
			<div class="tl-tools">
				{#if deployment.githubRepo}
					<Button
						variant="secondary"
						size="sm"
						onclick={onRebuild}
						disabled={rebuilding || isBuilding}
					>
						{#if rebuilding}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw
								size={14}
								class="h-3.5 w-3.5"
							/>{/if}
						<span>Redeploy</span>
					</Button>
				{/if}
			</div>
		</div>

		{#if loading}
			<div class="tl-list" aria-busy="true">
				<ActivityGroup>
					{#each [0, 1, 2, 3, 5, 6] as i (i)}
						<ActivityRow>
							{#snippet time()}<Skeleton width="2rem" height="0.6rem" />{/snippet}
							{#snippet tile()}<Skeleton
									width="1.5rem"
									height="1.5rem"
									rounded="var(--radius-sm)"
								/>{/snippet}
							{#snippet title()}<Skeleton width="12rem" height="0.75rem" />{/snippet}
						</ActivityRow>
					{/each}
				</ActivityGroup>
			</div>
		{:else if rows.length > 0}
			<div class="tl-list">
				{#each groups as group (group.key)}
					<ActivityGroup label={group.label}>
						{#each group.entries as entry (entry.id)}
							{@const badge = entryBadge(entry)}
							{@const tone = tileTone(entry)}
							{@const branch = str(entry.meta.branch)}
							{@const sha = str(entry.meta.commitSha)}
							{@const imageHistoryId = str(entry.meta.imageHistoryId)}
							{@const builtIn =
								entry.kind === 'release'
									? formatBuildDurationBetween(
											str(entry.meta.buildStartedAt) ?? undefined,
											str(entry.meta.buildCompletedAt) ?? undefined
										)
									: null}
							{@const who = actorLabel(entry)}
							<ActivityRow
								tone={badge.kind}
								muted={entry.kind === 'pod' || entry.kind === 'build'}
								struck={entry.kind === 'build' && entry.meta.buildStatus === 'skipped'}
								{@attach entranceFor(entry.id)}
								{@attach stateEcho(() => entry.id, { arrival: () => freshIds.has(entry.id) })}
							>
								{#snippet time()}
									<time datetime={entry.at} title={new Date(entry.at).toLocaleString()}
										>{clockLabel(entry.at, granularityFor(filter))}</time
									>
								{/snippet}
								{#snippet tile()}
									{#if entry.actor}
										<Avatar user={entry.actor} size={22} shape="rounded" />
									{:else if entry.kind === 'release' && appSrc}
										<IconTile
											src={appSrc}
											tint={!appIcon ? iconTint(deployment.id) : undefined}
											class="tl-app-icon"
											onerror={() => (favFailed = true)}
										>
											{#snippet fallback()}<span class="tl-app-fb"
													>{(deployment.displayName || deployment.name)
														.charAt(0)
														.toUpperCase()}</span
												>{/snippet}
										</IconTile>
									{:else}
										<ToneTile {tone} size={22} solid>
											{#if entry.kind === 'pod'}
												<Box class="h-3 w-3" />
											{:else if entry.kind === 'error'}
												<Bug class="h-3 w-3" />
											{:else if entry.kind === 'build' && tone === 'error'}
												<CircleX class="h-3 w-3" />
											{:else if entry.kind === 'audit'}
												<Settings2 class="h-3 w-3" />
											{:else}
												<GitCommit class="h-3 w-3" />
											{/if}
										</ToneTile>
									{/if}
								{/snippet}
								{#snippet title()}
									<span
										class="tl-title"
										class:tl-title--mono={entry.kind === 'release' &&
											!str(entry.meta.commitMessage)}
										title={str(entry.meta.commitMessage) ?? entry.title}>{entry.title}</span
									>
									{#if entry.kind === 'release' && entry.meta.isActive}
										<StatusBadge meta={statusMeta('success', 'Live', true)} />
									{:else if entry.kind === 'build'}
										<StatusBadge meta={statusMeta(badge.kind, badge.label, badge.pulse)} />
									{/if}
								{/snippet}
								{#snippet meta()}
									{#if entry.kind === 'release' || entry.kind === 'build'}
										{#if branch}<span class="tl-mono">{branch}</span>{/if}
										{#if sha}
											{#if entry.href}
												<a
													href={entry.href}
													target="_blank"
													rel="noopener noreferrer"
													class="tl-mono tl-link">{sha.slice(0, 7)}</a
												>
											{:else}<span class="tl-mono">{sha.slice(0, 7)}</span>{/if}
										{/if}
										{#if builtIn}<span class="tl-mono">{builtIn}</span>{/if}
										{#if entry.kind === 'build' && entry.detail}
											<span class:tl-err={badge.kind === 'error'}>{entry.detail}</span>
										{/if}
										{#if who}<span class="tl-who">{who}</span>{/if}
									{:else if entry.kind === 'pod'}
										<span class="tl-mono">{str(entry.meta.podName)}</span>
										{#if entry.steps}
											<span class="tl-steps">{entry.steps.join(' → ')}</span>
										{:else if podDetail(entry)}
											<span>{podDetail(entry)}</span>
										{/if}
									{:else if entry.kind === 'audit'}
										{#if entry.detail}<span title={entry.detail}>{entry.detail}</span>{/if}
										{#if who}<span class="tl-who">{who}</span>{/if}
									{:else if entry.detail}
										<span class="tl-err" title={entry.detail}>{entry.detail}</span>
									{/if}
								{/snippet}
								{#snippet actions()}
									{#if imageHistoryId}
										<Button
											variant="ghost"
											size="sm"
											onclick={() => onOpenLogModal(imageHistoryId)}
										>
											<Terminal size={14} class="h-3.5 w-3.5" />
											<span>Logs</span>
										</Button>
										{#if !entry.meta.isActive}
											<Button
												variant="ghost"
												size="sm"
												onclick={() => onRollback(imageHistoryId)}
												disabled={!!rollingBackId}
												loading={rollingBackId === imageHistoryId}
											>
												{#if rollingBackId !== imageHistoryId}<RotateCcw
														size={14}
														class="h-3.5 w-3.5"
													/>{/if}
												<span>Roll back</span>
											</Button>
										{/if}
									{/if}
								{/snippet}
							</ActivityRow>
						{/each}
					</ActivityGroup>
				{/each}
			</div>

			{#if timeline.hasNextPage}
				<div class="tl-more">
					<Button
						variant="ghost"
						size="sm"
						onclick={() => timeline.fetchNextPage()}
						loading={timeline.isFetchingNextPage}
						disabled={timeline.isFetchingNextPage}
					>
						{#if !timeline.isFetchingNextPage}<ArrowDown class="h-3.5 w-3.5" />{/if}
						<span>Older</span>
					</Button>
				</div>
			{/if}
		{:else}
			{@const empty = emptyCopy(filter)}
			<EmptyState title={empty.title} description={empty.description}>
				{#snippet icon()}<History size={28} />{/snippet}
			</EmptyState>
		{/if}
	</SectionCard>
</div>

<style>
	.tl {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.tl-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
		margin-bottom: var(--space-2);
	}
	.tl-tools {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
		justify-content: flex-end;
	}
	.tl-list {
		display: flex;
		flex-direction: column;
	}
	.tl-list :global(.tl-app-icon) {
		width: 1.375rem;
		height: 1.375rem;
		border-radius: var(--radius-xs);
	}
	.tl-app-fb {
		font-size: var(--text-micro);
		font-weight: 700;
		color: var(--text-on-accent);
	}
	.tl-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.tl-title--mono {
		font-family: var(--font-mono);
		letter-spacing: 0;
	}
	.tl-mono {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
	}
	.tl-link {
		color: inherit;
		text-decoration: none;
	}
	.tl-link:hover {
		color: var(--text-default);
		text-decoration: underline;
	}
	.tl-err {
		color: var(--status-error);
	}
	.tl-steps {
		color: var(--text-faint);
	}
	.tl-who {
		color: var(--text-faint);
	}
	.tl-who::before {
		content: '·';
		margin-right: var(--space-1);
	}
	.tl-more {
		display: flex;
		justify-content: center;
		padding-top: var(--space-3);
		border-top: 1px solid var(--rule);
	}
</style>
