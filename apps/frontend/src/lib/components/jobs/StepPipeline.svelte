<script lang="ts">
	import { FileCode, Container, Box } from 'lucide-svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import type { JobRunStep } from '$lib/types/jobs';
	import type { Snippet } from 'svelte';
	import StepStatusRing from './StepStatusRing.svelte';
	import LiveDuration from './LiveDuration.svelte';

	interface PipelineStep {
		stepOrder: number;
		name: string;
		type: 'app' | 'image' | 'script';
		summary?: string | null;
		runStep?: JobRunStep;
	}

	let {
		steps,
		expandable = false,
		expanded = $bindable(-1),
		detail = undefined
	}: {
		steps: PipelineStep[];
		expandable?: boolean;
		expanded?: number;
		detail?: Snippet<[PipelineStep]>;
	} = $props();

	const ICONS = { script: FileCode, app: Container, image: Box } as const;

	function segmentDone(step: PipelineStep): boolean {
		return step.runStep?.status === 'succeeded';
	}
</script>

<div class="job-pipeline">
	{#each steps as step, i (step.stepOrder)}
		{@const Icon = ICONS[step.type]}
		{@const dimmed = step.runStep && ['pending', 'skipped'].includes(step.runStep.status)}
		<div
			class="job-pipeline-step"
			class:job-pipeline-step--last={i === steps.length - 1}
			class:job-pipeline-step--done={segmentDone(step)}
			{@attach motionStagger({ index: i, stride: 0.05, from: { y: 10, opacity: 0 } })}
		>
			<span class="job-node-tag">
				<Icon size={11} />
				{step.type}
			</span>
			<svelte:element
				this={expandable ? 'button' : 'div'}
				class="job-pipeline-card"
				class:job-pipeline-card--clickable={expandable}
				class:job-pipeline-card--dimmed={dimmed}
				class:job-pipeline-card--failed={step.runStep &&
					['failed', 'timed_out'].includes(step.runStep.status)}
				class:job-pipeline-card--running={step.runStep?.status === 'running'}
				{...expandable ? { type: 'button' } : {}}
				onclick={expandable
					? () => (expanded = expanded === step.stepOrder ? -1 : step.stepOrder)
					: undefined}
			>
				<StepStatusRing status={step.runStep?.status ?? null} number={step.stepOrder} />
				<span class="job-pipeline-card-name">{step.name}</span>
				{#if step.summary}
					<span class="job-pipeline-card-summary font-mono">{step.summary}</span>
				{/if}
				<span class="job-pipeline-card-right">
					{#if step.runStep}
						<LiveDuration startedAt={step.runStep.startedAt} finishedAt={step.runStep.finishedAt} />
					{/if}
				</span>
			</svelte:element>
			{#if expandable && expanded === step.stepOrder && detail}
				<div
					class="job-pipeline-detail"
					{@attach motionStagger({ index: 0, from: { y: -8, opacity: 0 } })}
				>
					{@render detail(step)}
				</div>
			{/if}
		</div>
	{/each}
</div>
