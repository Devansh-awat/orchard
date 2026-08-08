<script lang="ts">
	import { ChevronUp, ChevronDown, Trash2, FileCode, Container, Box, Plus } from 'lucide-svelte';
	import { emptyStepDraft } from './steps';
	import { motionStagger, springHover } from '$lib/utils/motion.svelte';
	import StepEditor from './StepEditor.svelte';

	let {
		steps = $bindable([] as JobStepDraft[]),
		deployments = []
	}: {
		steps?: JobStepDraft[];
		deployments?: Array<{ id: string; name: string }>;
	} = $props();

	let expandedIndex = $state(steps.length === 1 ? 0 : -1);
	let showTypePicker = $state(steps.length === 0);

	function addStep(type: JobStepDraft['type']) {
		steps = [...steps, emptyStepDraft(type)];
		expandedIndex = steps.length - 1;
		showTypePicker = false;
	}

	function removeStep(i: number) {
		steps = steps.filter((_, idx) => idx !== i);
		if (expandedIndex >= steps.length) expandedIndex = steps.length - 1;
	}

	function move(i: number, dir: -1 | 1) {
		const j = i + dir;
		if (j < 0 || j >= steps.length) return;
		const next = [...steps];
		[next[i], next[j]] = [next[j], next[i]];
		steps = next;
		if (expandedIndex === i) expandedIndex = j;
		else if (expandedIndex === j) expandedIndex = i;
	}

	function summaryOf(s: JobStepDraft): string {
		if (s.type === 'script')
			return s.script.split('\n').find((l) => l.trim() && !l.startsWith('#!')) ?? 'script';
		if (s.type === 'image') return s.image || 'image';
		const dep = deployments.find((d) => d.id === s.deploymentId);
		return `${dep?.name ?? 'app'}: ${s.command || '…'}`;
	}

	const TYPE_META = {
		script: { icon: FileCode, label: 'Script' },
		app: { icon: Container, label: 'App command' },
		image: { icon: Box, label: 'Custom image' }
	} as const;
</script>

<div class="job-step-list">
	{#each steps as step, i (i)}
		{@const TypeIcon = TYPE_META[step.type].icon}
		<div class="job-step-card" class:job-step-card--open={expandedIndex === i}>
			<div class="job-step-card-header">
				<button
					type="button"
					class="job-step-card-toggle"
					onclick={() => (expandedIndex = expandedIndex === i ? -1 : i)}
				>
					<span class="job-step-index">{i + 1}</span>
					<TypeIcon size={14} class="job-step-type-icon" />
					<span class="job-step-card-name">{step.name.trim() || `Step ${i + 1}`}</span>
					{#if step.type === 'script'}
						<code class="job-inline-code">{step.scriptRuntime}</code>
					{/if}
					<span class="job-step-card-summary font-mono">{summaryOf(step)}</span>
				</button>
				<span class="job-step-card-actions">
					<button
						type="button"
						class="job-step-icon-btn"
						aria-label="Move up"
						disabled={i === 0}
						onclick={() => move(i, -1)}
					>
						<ChevronUp size={14} />
					</button>
					<button
						type="button"
						class="job-step-icon-btn"
						aria-label="Move down"
						disabled={i === steps.length - 1}
						onclick={() => move(i, 1)}
					>
						<ChevronDown size={14} />
					</button>
					<button
						type="button"
						class="job-step-icon-btn job-step-icon-btn--danger"
						aria-label="Remove step"
						onclick={() => removeStep(i)}
					>
						<Trash2 size={14} />
					</button>
				</span>
			</div>
			{#if expandedIndex === i}
				<div
					class="job-step-card-body"
					{@attach motionStagger({ index: 0, from: { y: -8, opacity: 0 } })}
				>
					<StepEditor bind:step={steps[i]} index={i} {deployments} />
				</div>
			{/if}
		</div>
	{/each}

	{#if showTypePicker || steps.length === 0}
		<div class="job-step-type-picker">
			<button
				type="button"
				class="job-step-type-tile job-step-type-tile--script"
				{@attach springHover({ lift: -2 })}
				onclick={() => addStep('script')}
			>
				<FileCode size={22} />
				<span class="job-step-type-tile-title">Script</span>
				<span class="job-step-type-tile-langs">
					<code class="job-inline-code">bash</code>
					<code class="job-inline-code">python</code>
					<code class="job-inline-code">node</code>
				</span>
			</button>
			<button
				type="button"
				class="job-step-type-tile"
				{@attach springHover({ lift: -2 })}
				onclick={() => addStep('app')}
			>
				<Container size={20} />
				<span class="job-step-type-tile-title">App command</span>
			</button>
			<button
				type="button"
				class="job-step-type-tile"
				{@attach springHover({ lift: -2 })}
				onclick={() => addStep('image')}
			>
				<Box size={20} />
				<span class="job-step-type-tile-title">Custom image</span>
			</button>
		</div>
	{:else}
		<button type="button" class="job-step-add" onclick={() => (showTypePicker = true)}>
			<Plus size={14} />
			Add step
		</button>
	{/if}
</div>
