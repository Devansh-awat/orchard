<script lang="ts">
	import { goto } from '$app/navigation';
	import { Play, MoreVertical, Pause, Pencil, Trash2, CalendarClock } from 'lucide-svelte';
	import { springHover } from '$lib/utils/motion.svelte';
	import { formatRelativeTime } from '$lib/utils/format';
	import { Button, Menu, MenuItem } from '$lib/components/ui';
	import type { Job } from '$lib/types/jobs';
	import JobStatusBadge from './JobStatusBadge.svelte';
	import ScheduleBadge from './ScheduleBadge.svelte';
	import RunHistoryStrip from './RunHistoryStrip.svelte';
	import LiveDuration from './LiveDuration.svelte';

	let {
		job,
		orgSlug,
		runningNow = false,
		onRunNow,
		onTogglePause,
		onDelete
	}: {
		job: Job;
		orgSlug: string;
		runningNow?: boolean;
		onRunNow: (job: Job) => void;
		onTogglePause: (job: Job) => void;
		onDelete: (job: Job) => void;
	} = $props();

	const lastRunActive = $derived(
		job.lastRun && ['pending', 'running'].includes(job.lastRun.status)
	);

	function relTime(iso: string | null): string {
		if (!iso) return '';
		return formatRelativeTime(new Date(iso));
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
	class="job-card"
	{@attach springHover({ lift: -1 })}
	onclick={() => goto(`/${orgSlug}/jobs/${job.id}`)}
>
	<div class="job-card-main">
		<div class="job-card-title-row">
			<span class="job-card-name">{job.name}</span>
			<span class="job-card-project">{job.projectName}</span>
		</div>
		{#if job.description}
			<p class="job-card-desc">{job.description}</p>
		{/if}
		<div class="job-card-meta">
			<ScheduleBadge
				scheduleCron={job.scheduleCron}
				timeZone={job.timeZone}
				enabled={job.enabled}
			/>
			{#if job.nextRunAt && job.enabled}
				<span class="job-card-next">
					<CalendarClock size={12} />
					next {relTime(job.nextRunAt)}
				</span>
			{/if}
		</div>
	</div>

	<div class="job-card-history">
		{#if job.recentRuns?.length}
			<RunHistoryStrip runs={job.recentRuns} {orgSlug} jobId={job.id} />
		{/if}
	</div>

	<div class="job-card-lastrun">
		{#if job.lastRun}
			<JobStatusBadge status={job.lastRun.status} />
			{#if lastRunActive}
				<LiveDuration startedAt={job.lastRun.startedAt} />
			{:else}
				<span class="job-card-lastrun-time">
					{relTime(job.lastRun.finishedAt ?? job.lastRun.createdAt)}
				</span>
			{/if}
		{:else}
			<span class="job-card-lastrun-time">Never run</span>
		{/if}
	</div>

	<div class="job-card-actions">
		<Button
			variant="ghost"
			size="sm"
			loading={runningNow}
			onclick={(e: MouseEvent) => {
				e.stopPropagation();
				onRunNow(job);
			}}
		>
			<Play size={13} />
			Run
		</Button>
		<Menu>
			{#snippet trigger(props)}
				<button
					type="button"
					class="job-card-menu-btn"
					aria-label="Job actions"
					{...props}
					onclick={(e: MouseEvent) => {
						e.stopPropagation();
						(props as any).onclick?.(e);
					}}
				>
					<MoreVertical size={15} />
				</button>
			{/snippet}
			{#if job.scheduleCron}
				<MenuItem onclick={() => onTogglePause(job)}>
					<Pause size={13} />
					{job.enabled ? 'Pause schedule' : 'Resume schedule'}
				</MenuItem>
			{/if}
			<MenuItem href="/{orgSlug}/jobs/{job.id}?tab=settings">
				<Pencil size={13} />
				Edit
			</MenuItem>
			<MenuItem danger onclick={() => onDelete(job)}>
				<Trash2 size={13} />
				Delete
			</MenuItem>
		</Menu>
	</div>
</div>
