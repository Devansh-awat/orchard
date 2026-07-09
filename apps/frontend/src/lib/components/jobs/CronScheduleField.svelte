<script lang="ts">
	import { Field, Input, Dropdown } from '$lib/components/ui';
	import { CRON_PRESETS, describeCron, validateCron } from '$lib/utils/cron';

	let {
		scheduleCron = $bindable(null as string | null),
		idPrefix = 'job'
	}: {
		scheduleCron?: string | null;
		idPrefix?: string;
	} = $props();

	const presetFor = (cron: string | null): string => {
		if (!cron) return 'none';
		return CRON_PRESETS.some((p) => p.value === cron) ? cron : 'custom';
	};

	let preset = $state(presetFor(scheduleCron));
	let customCron = $state(scheduleCron && presetFor(scheduleCron) === 'custom' ? scheduleCron : '');

	// Resync when the bound cron changes from outside (e.g. the settings form
	// seeds the job's schedule after this component has already mounted).
	let lastCron = scheduleCron;
	$effect(() => {
		if (scheduleCron !== lastCron) {
			lastCron = scheduleCron;
			preset = presetFor(scheduleCron);
			if (preset === 'custom') customCron = scheduleCron ?? '';
		}
	});

	const presetOptions = [
		{ value: 'none', label: 'Manual only' },
		...CRON_PRESETS.map((p) => ({ value: p.value, label: p.label })),
		{ value: 'custom', label: 'Custom cron…' }
	];

	function onPresetChange(next: string) {
		if (next === 'none') scheduleCron = null;
		else if (next === 'custom') scheduleCron = customCron.trim() || null;
		else scheduleCron = next;
		lastCron = scheduleCron;
	}

	function onCustomInput() {
		if (preset === 'custom') scheduleCron = customCron.trim() || null;
		lastCron = scheduleCron;
	}

	const cronError = $derived(
		preset === 'custom' && customCron.trim() ? validateCron(customCron) : null
	);
	const preview = $derived.by(() => {
		if (!scheduleCron) return null;
		if (cronError) return null;
		return describeCron(scheduleCron, null);
	});
</script>

<div class="grid gap-3 md:grid-cols-2">
	<Field label="Schedule" for="{idPrefix}-schedule-preset">
		<Dropdown
			id="{idPrefix}-schedule-preset"
			bind:value={preset}
			options={presetOptions}
			onchange={onPresetChange}
		/>
	</Field>
	{#if preset === 'custom'}
		<Field label="Cron expression" for="{idPrefix}-schedule-cron" error={cronError}>
			<Input
				id="{idPrefix}-schedule-cron"
				type="text"
				class="font-mono text-sm"
				placeholder="0 2 * * *"
				bind:value={customCron}
				oninput={onCustomInput}
			/>
		</Field>
	{/if}
</div>
{#if preview}
	<p class="job-cron-preview">
		<span class="job-cron-preview-dot"></span>
		{preview}
		{#if preset === 'custom'}<code class="job-inline-code">{scheduleCron}</code>{/if}
	</p>
{/if}
