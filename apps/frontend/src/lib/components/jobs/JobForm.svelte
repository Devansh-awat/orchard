<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Field, Input, Dropdown } from '$lib/components/ui';
	import type { JobStepDraft } from '$lib/types/jobs';
	import CronScheduleField from './CronScheduleField.svelte';
	import StepList from './StepList.svelte';

	let {
		name = $bindable(''),
		description = $bindable(''),
		scheduleCron = $bindable(null as string | null),
		concurrencyPolicy = $bindable('forbid' as 'allow' | 'forbid'),
		steps = $bindable([] as JobStepDraft[]),
		deployments = [],
		lead = undefined
	}: {
		name?: string;
		description?: string;
		scheduleCron?: string | null;
		concurrencyPolicy?: 'allow' | 'forbid';
		steps?: JobStepDraft[];
		deployments?: Array<{ id: string; name: string }>;
		lead?: Snippet;
	} = $props();
</script>

<div class="job-form-card">
	{#if lead}
		<section class="job-form-section">
			{@render lead()}
		</section>
	{/if}

	<section class="job-form-section">
		<div class="job-form-section-head">
			<h3 class="job-form-section-name">Details</h3>
			<p class="job-form-section-sub">A name and optional description.</p>
		</div>
		<div class="grid gap-3 md:grid-cols-2">
			<Field label="Name" for="job-name">
				<Input id="job-name" placeholder="nightly-cleanup" bind:value={name} />
			</Field>
			<Field label="Description" for="job-description">
				<Input id="job-description" placeholder="Optional" bind:value={description} />
			</Field>
		</div>
	</section>

	<section class="job-form-section">
		<div class="job-form-section-head">
			<h3 class="job-form-section-name">Trigger</h3>
			<p class="job-form-section-sub">Run on a schedule, on demand, or both.</p>
		</div>
		<CronScheduleField bind:scheduleCron idPrefix="job" />
		<div class="mt-3 grid gap-3 md:grid-cols-2">
			<Field label="If a run is still going" for="job-concurrency">
				<Dropdown
					id="job-concurrency"
					bind:value={concurrencyPolicy}
					options={[
						{ value: 'forbid', label: 'Skip the new run' },
						{ value: 'allow', label: 'Run them in parallel' }
					]}
				/>
			</Field>
		</div>
	</section>

	<section class="job-form-section">
		<div class="job-form-section-head">
			<h3 class="job-form-section-name">Steps</h3>
			<p class="job-form-section-sub">Run in order — a failure stops the pipeline.</p>
		</div>
		<StepList bind:steps {deployments} />
	</section>
</div>
