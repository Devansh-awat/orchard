<script lang="ts">
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { createQuery } from '@tanstack/svelte-query';
	import { Plus } from 'lucide-svelte';
	import {
		apiFetch,
		toasts,
		subscribeOrgEvents,
		selectedOrganization,
		sseStatusFor
	} from '$lib/stores';
	import { queryClient } from '$lib/query';
	import { jobsQueryOptions } from '$lib/queries/jobs';
	import { Button, Dropdown, Skeleton } from '$lib/components/ui';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { JobCard } from '$lib/components/jobs';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import type { Job } from '$lib/types/jobs';
	import type { PageData } from './$types';
	import '$lib/components/jobs/jobs.css';
	import './jobs-page.css';

	let { data } = $props<{ data: PageData }>();
	const orgSlug = $derived(data.orgSlug);
	const orgId = $derived($selectedOrganization?.id ?? '');

	let sseStatusValue = $state<'connecting' | 'connected' | 'disconnected'>('connecting');
	let sseUnsubs: Array<() => void> = [];
	let subscribedOrgId: string | null = null;

	$effect(() => {
		if (!orgId || subscribedOrgId === orgId) return;
		sseUnsubs.forEach((u) => u());
		sseUnsubs = [
			subscribeOrgEvents(orgId, () => {}),
			sseStatusFor(orgId).subscribe((s) => (sseStatusValue = s))
		];
		subscribedOrgId = orgId;
	});
	onDestroy(() => sseUnsubs.forEach((u) => u()));

	const jobsQuery = createQuery(() => ({
		...jobsQueryOptions(orgId),
		enabled: !!orgId,
		refetchInterval: (query: { state: { data?: Job[] } }) => {
			const sseUp = sseStatusValue === 'connected';
			const hasActive = (query.state.data ?? []).some(
				(j) => j.lastRun && ['pending', 'running'].includes(j.lastRun.status)
			);
			if (hasActive) return sseUp ? 15_000 : 3_000;
			return sseUp ? false : 30_000;
		},
		refetchIntervalInBackground: true
	}));

	const jobs = $derived((jobsQuery.data ?? []) as Job[]);
	const loading = $derived(jobsQuery.isPending);

	let projectFilter = $state('all');
	const projectOptions = $derived.by(() => {
		const map = new Map<string, string>();
		for (const j of jobs) {
			if (j.projectId && j.projectName) map.set(j.projectId, j.projectName);
		}
		return Array.from(map, ([id, name]) => ({ id, name }));
	});
	const visibleJobs = $derived(
		projectFilter === 'all' ? jobs : jobs.filter((j) => j.projectId === projectFilter)
	);

	let runningNowId = $state<string | null>(null);
	async function runNow(job: Job) {
		if (runningNowId) return;
		runningNowId = job.id;
		try {
			const res = await apiFetch(`/apiv1/jobs/${job.id}/runs`, { method: 'POST' });
			if (res.status === 409) {
				toasts.add({ title: 'A run is already in progress', color: 'error' });
				return;
			}
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to start run');
			}
			const run = await res.json();
			goto(`/${orgSlug}/jobs/${job.id}/runs/${run.id}`);
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Failed to start run', color: 'error' });
		} finally {
			runningNowId = null;
		}
	}

	async function togglePause(job: Job) {
		try {
			const res = await apiFetch(`/apiv1/jobs/${job.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: !job.enabled })
			});
			if (!res.ok) throw new Error('Failed to update job');
			toasts.add({
				title: job.enabled ? 'Schedule paused' : 'Schedule resumed',
				color: 'success'
			});
			queryClient.invalidateQueries({ queryKey: ['jobs', orgId] });
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Failed', color: 'error' });
		}
	}

	let deleteTarget = $state<Job | null>(null);
	let deleteModalOpen = $state(false);
	async function deleteJob() {
		const target = deleteTarget;
		if (!target) return;
		try {
			const res = await apiFetch(`/apiv1/jobs/${target.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error('Failed to delete job');
			toasts.add({ title: `Deleted "${target.name}"`, color: 'success' });
			queryClient.invalidateQueries({ queryKey: ['jobs', orgId] });
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Failed to delete', color: 'error' });
		} finally {
			deleteTarget = null;
		}
	}
</script>

<svelte:head>
	<title>Jobs · Orchard</title>
</svelte:head>

<div class="jobs-page">
	<div class="jobs-page-header">
		<div>
			<h1 class="jobs-page-title">Jobs</h1>
		</div>
		<div class="jobs-page-header-actions">
			{#if projectOptions.length > 1}
				<Dropdown
					bind:value={projectFilter}
					placement="bottom-end"
					options={[
						{ value: 'all', label: 'All projects' },
						...projectOptions.map((p) => ({ value: p.id, label: p.name }))
					]}
				/>
			{/if}
			<Button variant="primary" href="/{orgSlug}/jobs/new">
				<Plus size={15} />
				New job
			</Button>
		</div>
	</div>

	{#if loading}
		<div class="jobs-list">
			{#each [0, 1, 2] as i (i)}
				<Skeleton height="86px" rounded="1rem" />
			{/each}
		</div>
	{:else if visibleJobs.length === 0}
		<div class="jobs-empty">
			<div class="jobs-ghost" aria-hidden="true">
				<div class="jobs-ghost-node">
					<span class="jobs-ghost-tag"></span>
					<div class="jobs-ghost-card">
						<span class="jobs-ghost-ring"></span>
						<span class="jobs-ghost-line" style="width: 42%"></span>
					</div>
				</div>
				<div class="jobs-ghost-connector"></div>
				<div class="jobs-ghost-node">
					<span class="jobs-ghost-tag"></span>
					<div class="jobs-ghost-card">
						<span class="jobs-ghost-ring"></span>
						<span class="jobs-ghost-line" style="width: 60%"></span>
					</div>
				</div>
			</div>
			<h3 class="jobs-empty-title">No jobs yet</h3>
			<p class="jobs-empty-desc">Scripts, commands and containers on a schedule or on demand.</p>
			<Button variant="primary" href="/{orgSlug}/jobs/new">New job</Button>
		</div>
	{:else}
		<div class="jobs-list">
			{#each visibleJobs as job, i (job.id)}
				<div {@attach motionStagger({ index: i })}>
					<JobCard
						{job}
						{orgSlug}
						runningNow={runningNowId === job.id}
						onRunNow={runNow}
						onTogglePause={togglePause}
						onDelete={(j) => {
							deleteTarget = j;
							deleteModalOpen = true;
						}}
					/>
				</div>
			{/each}
		</div>
	{/if}
</div>

<ConfirmModal
	bind:open={deleteModalOpen}
	title="Delete job?"
	description={`"${deleteTarget?.name ?? ''}" and its run history will be permanently deleted.`}
	confirmLabel="Delete job"
	onconfirm={deleteJob}
	oncancel={() => (deleteTarget = null)}
/>
