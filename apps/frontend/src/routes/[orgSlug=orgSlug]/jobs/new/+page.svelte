<script lang="ts">
	import { goto } from '$app/navigation';
	import { createQuery } from '@tanstack/svelte-query';
	import { ArrowLeft } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { overviewQueryOptions } from '$lib/queries/overview';
	import { Button, Dropdown, Alert } from '$lib/components/ui';
	import { JobForm, draftError, draftToPayload } from '$lib/components/jobs';
	import type { JobStepDraft } from '$lib/types/jobs';
	import type { PageData } from './$types';
	import '$lib/components/jobs/jobs.css';
	import '../jobs-page.css';

	let { data } = $props<{ data: PageData }>();
	const orgSlug = $derived(data.orgSlug);

	const overviewQuery = createQuery(() => ({
		...overviewQueryOptions(orgSlug),
		enabled: !!orgSlug
	}));

	interface ProjectOption {
		id: string;
		name: string;
		deployments?: Array<{ id: string; name: string }>;
	}
	const projects = $derived((overviewQuery.data?.projects ?? []) as ProjectOption[]);

	let projectId = $state('');
	let name = $state('');
	let description = $state('');
	let scheduleCron = $state<string | null>(null);
	let concurrencyPolicy = $state<'allow' | 'forbid'>('forbid');
	let steps = $state<JobStepDraft[]>([]);
	let creating = $state(false);
	let formError = $state<string | null>(null);

	let projectDefaulted = false;
	$effect(() => {
		if (!projectDefaulted && projects.length > 0 && !projectId) {
			projectId = projects[0].id;
			projectDefaulted = true;
		}
	});

	const projectDeployments = $derived(projects.find((p) => p.id === projectId)?.deployments ?? []);

	async function create() {
		formError = null;
		if (!projectId) {
			formError = 'Select a project';
			return;
		}
		if (!name.trim()) {
			formError = 'Give the job a name';
			return;
		}
		const stepsError = draftError(steps);
		if (stepsError) {
			formError = stepsError;
			return;
		}
		creating = true;
		try {
			const res = await apiFetch(`/apiv1/projects/${projectId}/jobs`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: name.trim(),
					description: description.trim() || undefined,
					scheduleCron: scheduleCron ?? undefined,
					concurrencyPolicy,
					steps: draftToPayload(steps)
				})
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || "Couldn't create job");
			}
			const job = await res.json();
			toasts.add({ title: `Created "${job.name}"`, color: 'success' });
			goto(`/${orgSlug}/jobs/${job.id}`);
		} catch (e) {
			formError = e instanceof Error ? e.message : "Couldn't create job";
		} finally {
			creating = false;
		}
	}
</script>

<svelte:head>
	<title>New job · Orchard</title>
</svelte:head>

<div class="jobs-page">
	<div class="jobs-page-header">
		<div>
			<a href="/{orgSlug}/jobs" class="jobs-back-link">
				<ArrowLeft size={14} />
				Jobs
			</a>
			<h1 class="jobs-page-title">New job</h1>
		</div>
	</div>

	<div class="jobs-form-wrap">
		<JobForm
			bind:name
			bind:description
			bind:scheduleCron
			bind:concurrencyPolicy
			bind:steps
			deployments={projectDeployments}
		>
			{#snippet lead()}
				<div class="job-form-section-head">
					<h3 class="job-form-section-name">Project</h3>
					<p class="job-form-section-sub">Runs in this project and counts against its quota.</p>
				</div>
				<Dropdown
					id="job-project"
					bind:value={projectId}
					placeholder={projects.length === 0 ? 'Loading projects…' : 'Select a project…'}
					options={projects.map((p) => ({ value: p.id, label: p.name }))}
				/>
			{/snippet}
		</JobForm>

		{#if formError}
			<Alert tone="error">{formError}</Alert>
		{/if}

		<div class="jobs-form-actions">
			<Button variant="primary" loading={creating} onclick={create}>Create job</Button>
			<Button variant="secondary" href="/{orgSlug}/jobs">Cancel</Button>
		</div>
	</div>
</div>
