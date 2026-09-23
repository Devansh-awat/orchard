<script lang="ts">
	import { Loader2, RotateCcw, GitBranch, ArrowRight, Timer } from 'lucide-svelte';
	import { Terminal } from '@jis3r/icons';
	import BuildTimer from '$lib/components/BuildTimer.svelte';
	import { stateEcho } from '$lib/utils/motion.svelte';
	import { formatBuildDurationBetween, formatRelativeTime } from '$lib/utils/format';
	import { StatusBadge, statusMeta, Button } from '$lib/components/ui';
	import type { Deployment } from '$lib/types/deployment';
	import RolloutPath from './RolloutPath.svelte';
	import {
		buildStartedAt,
		humanizeStep,
		originLabel,
		shortRef,
		type TimelineEntry
	} from './timeline-rows';

	let {
		live,
		previous,
		deployment,
		rollingBackId = null,
		onRollback,
		onOpenLogModal,
		onViewBuildLogs
	}: {
		live: TimelineEntry | null;
		previous: TimelineEntry | null;
		deployment: Deployment;
		rollingBackId?: string | null;
		onRollback: (historyId: string) => void;
		onOpenLogModal: (historyId: string) => void;
		onViewBuildLogs: () => void;
	} = $props();

	const building = $derived(
		deployment.buildStatus === 'building' ||
			deployment.buildStatus === 'queued' ||
			deployment.buildStatus === 'pending'
	);
	const failed = $derived(deployment.buildStatus === 'failed');
	const from = $derived(building ? live : previous);
	const tone = $derived(building ? 'progress' : failed ? 'error' : 'success');
	const startedAt = $derived(buildStartedAt(deployment.buildStepTimestamps));
	const builtIn = $derived(
		live
			? formatBuildDurationBetween(
					str(live.meta.buildStartedAt) ?? undefined,
					str(live.meta.buildCompletedAt) ?? undefined
				)
			: null
	);
	const branch = $derived(str(live?.meta.branch));
	const liveId = $derived(str(live?.meta.imageHistoryId));
	const fromId = $derived(str(from?.meta.imageHistoryId));
	const buildError = $derived(deployment.buildError?.split('\n')[0] ?? null);

	function hasMessage(entry: TimelineEntry | null): boolean {
		return typeof entry?.meta.commitMessage === 'string' && entry.meta.commitMessage.trim() !== '';
	}

	function str(v: unknown): string | null {
		return typeof v === 'string' && v ? v : null;
	}
</script>

{#if live || building || failed}
	<section
		class="rc rc--{tone} motion-echo echo--{tone}"
		{@attach stateEcho(() => `${liveId}:${deployment.buildStatus}`)}
		aria-label="Current release"
	>
		<div class="rc-end rc-end--from">
			{#if from}
				{#if hasMessage(from)}
					<span class="rc-msg" title={from.title}>{from.title}</span>
					<span class="rc-ref">{shortRef(from)}</span>
				{:else}
					<span class="rc-msg rc-msg--ref">{shortRef(from)}</span>
				{/if}
				<span class="rc-sub">{formatRelativeTime(new Date(from.at))} · {originLabel(from)}</span>
				{#if fromId && !building}
					<span class="rc-act">
						<Button
							variant="secondary"
							size="sm"
							onclick={() => onRollback(fromId)}
							disabled={!!rollingBackId}
							loading={rollingBackId === fromId}
						>
							{#if rollingBackId !== fromId}<RotateCcw size={14} class="h-3.5 w-3.5" />{/if}
							<span>Roll back</span>
						</Button>
					</span>
				{/if}
			{:else}
				<span class="rc-msg rc-msg--faint">First release</span>
			{/if}
		</div>

		<RolloutPath {tone} moving={building} hollowEnd={failed}>
			{#if building}
				<Loader2 class="h-3 w-3 animate-spin" data-motion="progress" />
				<span>{humanizeStep(deployment.buildStep)}</span>
				{#if startedAt}<span class="rc-chip-time"><BuildTimer {startedAt} /></span>{/if}
			{:else if failed}
				<span>Did not ship</span>
			{:else}
				<ArrowRight class="h-3 w-3" />
				{#if builtIn}<span class="rc-mono"><Timer class="h-3 w-3" />{builtIn}</span>{/if}
				{#if branch}<span class="rc-mono"><GitBranch class="h-3 w-3" />{branch}</span>{/if}
			{/if}
		</RolloutPath>

		<div class="rc-end rc-end--to">
			{#if building}
				<span class="rc-status"
					><StatusBadge meta={statusMeta('progress', 'Deploying', true)} variant="solid" /></span
				>
				<span class="rc-msg rc-msg--strong"
					>{deployment.githubBranch ? `Building ${deployment.githubBranch}` : 'Building'}</span
				>
				<span class="rc-act">
					<Button variant="ghost" size="sm" onclick={onViewBuildLogs}>
						<Terminal size={14} class="h-3.5 w-3.5" />
						<span>Build logs</span>
					</Button>
				</span>
			{:else if failed}
				<span class="rc-status"
					><StatusBadge meta={statusMeta('error', 'Failed')} variant="solid" /></span
				>
				<span class="rc-msg rc-msg--error" title={deployment.buildError ?? undefined}
					>{buildError ?? 'The last build failed'}</span
				>
				{#if live}<span class="rc-sub">{shortRef(live)} is still live</span>{/if}
				<span class="rc-act">
					<Button variant="ghost" size="sm" onclick={onViewBuildLogs}>
						<Terminal size={14} class="h-3.5 w-3.5" />
						<span>Build logs</span>
					</Button>
				</span>
			{:else if live}
				<span class="rc-status">
					<StatusBadge meta={statusMeta('success', 'Live', true)} variant="solid" />
				</span>
				{#if hasMessage(live)}
					<span class="rc-msg rc-msg--strong" title={live.title}>{live.title}</span>
					<span class="rc-ref">{shortRef(live)}</span>
				{:else}
					<span class="rc-msg rc-msg--strong rc-msg--ref">{shortRef(live)}</span>
				{/if}
				<span class="rc-sub">{formatRelativeTime(new Date(live.at))} · {originLabel(live)}</span>
				{#if liveId}
					<span class="rc-act">
						<Button variant="ghost" size="sm" onclick={() => onOpenLogModal(liveId)}>
							<Terminal size={14} class="h-3.5 w-3.5" />
							<span>Build logs</span>
						</Button>
					</span>
				{/if}
			{/if}
		</div>
	</section>
{/if}

<style>
	.rc {
		display: grid;
		grid-template-columns: minmax(0, 5fr) minmax(9rem, 4fr) minmax(0, 6fr);
		grid-template-areas: 'from path to';
		column-gap: var(--space-4);
		align-items: center;
		padding: var(--space-4) var(--space-5);
		border-radius: var(--radius-xl);
		background: var(--bg-raised);
		box-shadow:
			inset 0 1px 0 color-mix(in srgb, var(--text-default) 7%, transparent),
			var(--elev-1);
		position: relative;
		overflow: hidden;
	}
	.rc--success {
		--rc-tone: var(--status-success);
	}
	.rc--progress {
		--rc-tone: var(--status-progress);
	}
	.rc--error {
		--rc-tone: var(--status-error);
	}
	.rc-end {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
		position: relative;
	}
	.rc-end--from {
		grid-area: from;
	}
	.rc-end--to {
		grid-area: to;
		align-items: flex-end;
		text-align: right;
	}
	.rc-status {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
	}
	.rc-ref {
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
		letter-spacing: 0.02em;
	}
	.rc-msg--ref {
		font-family: var(--font-mono);
		letter-spacing: 0;
	}
	.rc-msg--faint {
		color: var(--text-faint);
	}
	.rc-msg {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		letter-spacing: var(--track-headline);
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 100%;
	}
	.rc-msg--strong {
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: 700;
		letter-spacing: var(--track-headline);
		color: var(--text-default);
	}
	.rc-msg--error {
		font-family: var(--font-mono);
		font-size: var(--text-footnote);
		font-weight: 500;
		color: var(--status-error);
	}
	.rc-sub {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 100%;
	}
	.rc-act {
		margin-top: var(--space-1);
		display: inline-flex;
	}
	.rc-chip-time {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
	}
	.rc-mono {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
	}
	@media (max-width: 760px) {
		.rc {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas:
				'from'
				'path'
				'to';
			gap: var(--space-3);
		}
		.rc-end--to {
			align-items: flex-start;
			text-align: left;
		}
	}
</style>
