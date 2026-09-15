<script lang="ts">
	import { ScrollText } from 'lucide-svelte';
	import SettingsSection from './SettingsSection.svelte';
	import { Button, SegmentedControl } from '$lib/components/ui';
	import { ansiToHtml } from '$lib/utils/format';
	import {
		logDisplay,
		setLogDisplay,
		resetLogDisplay,
		isLogDisplayDefault,
		type LogClock,
		type LogDate,
		type LogZone
	} from '$lib/stores/log-display.svelte';

	let { index = 0 }: { index?: number } = $props();

	const CLOCK_OPTIONS: { value: LogClock; label: string; hint: string }[] = [
		{ value: 'system', label: 'System', hint: 'Follows the clock format of your locale' },
		{ value: '12', label: '12 hour', hint: 'Times read 08:16:07 PM' },
		{ value: '24', label: '24 hour', hint: 'Times read 20:16:07' }
	];

	const ZONE_OPTIONS: { value: LogZone; label: string; hint: string }[] = [
		{ value: 'local', label: 'Local', hint: 'Times are shown in your own time zone' },
		{ value: 'utc', label: 'UTC', hint: 'Times match what the cluster recorded' }
	];

	const DATE_OPTIONS: { value: LogDate; label: string; hint: string }[] = [
		{ value: 'auto', label: 'When it changes', hint: 'Dates appear once a line is not from today' },
		{ value: 'always', label: 'Always', hint: 'Every line carries its date' },
		{ value: 'never', label: 'Never', hint: 'Times only, whatever day the line is from' }
	];

	const MS_OPTIONS = [
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' }
	];

	const ESC = '';

	const clockHint = $derived(CLOCK_OPTIONS.find((o) => o.value === logDisplay.clock)?.hint ?? '');
	const zoneHint = $derived(ZONE_OPTIONS.find((o) => o.value === logDisplay.zone)?.hint ?? '');
	const dateHint = $derived(DATE_OPTIONS.find((o) => o.value === logDisplay.date)?.hint ?? '');

	const sample = $derived.by(() => {
		const now = new Date();
		const yesterday = new Date(now.getTime() - 26 * 60 * 60 * 1000);
		const green = `${ESC}[32m`;
		const red = `${ESC}[31m`;
		const off = `${ESC}[0m`;
		return ansiToHtml(
			[
				`${yesterday.toISOString()} ${green}GET${off} /api/health ready in 0.8ms`,
				`${now.toISOString()} ${green}GET${off} /api/deployments ready in 42.1ms`,
				`${now.toISOString()} ${red}GET${off} /api/activity/recent failed in 1229.6ms`
			].join('\n')
		);
	});
</script>

<SettingsSection
	{index}
	title="Logs"
	description="How timestamps read in log panes and consoles. Hover one for the full detail."
>
	{#snippet icon(_hovered)}<ScrollText class="h-[18px] w-[18px]" />{/snippet}

	{#snippet actions()}
		{#if !isLogDisplayDefault()}
			<Button variant="ghost" size="sm" onclick={resetLogDisplay}>Reset</Button>
		{/if}
	{/snippet}

	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	<pre class="ul-preview">{@html sample}</pre>

	<div class="ul-rows">
		<div class="ul-row">
			<div class="ul-text">
				<span class="ul-title">Clock</span>
				<span class="ul-hint">{clockHint}</span>
			</div>
			<SegmentedControl
				options={CLOCK_OPTIONS}
				value={logDisplay.clock}
				label="Clock"
				onchange={(v) => setLogDisplay('clock', v as LogClock)}
			/>
		</div>

		<div class="ul-row">
			<div class="ul-text">
				<span class="ul-title">Time zone</span>
				<span class="ul-hint">{zoneHint}</span>
			</div>
			<SegmentedControl
				options={ZONE_OPTIONS}
				value={logDisplay.zone}
				label="Time zone"
				onchange={(v) => setLogDisplay('zone', v as LogZone)}
			/>
		</div>

		<div class="ul-row">
			<div class="ul-text">
				<span class="ul-title">Show the date</span>
				<span class="ul-hint">{dateHint}</span>
			</div>
			<SegmentedControl
				options={DATE_OPTIONS}
				value={logDisplay.date}
				label="Show the date"
				onchange={(v) => setLogDisplay('date', v as LogDate)}
			/>
		</div>

		<div class="ul-row">
			<div class="ul-text">
				<span class="ul-title">Milliseconds</span>
				<span class="ul-hint">Worth it for reading latency, noise the rest of the time</span>
			</div>
			<SegmentedControl
				options={MS_OPTIONS}
				value={logDisplay.milliseconds ? 'on' : 'off'}
				label="Milliseconds"
				onchange={(v) => setLogDisplay('milliseconds', v === 'on')}
			/>
		</div>
	</div>
</SettingsSection>

<style>
	.ul-preview {
		margin: 0 0 1.25rem;
		padding: 0.75rem;
		border: 1px solid var(--console-edge);
		border-radius: var(--radius-md);
		background: var(--console-bg);
		color: var(--console-text);
		font-family: var(--font-mono);
		font-size: var(--text-micro);
		line-height: 1.65;
		white-space: pre-wrap;
		word-break: break-all;
		overflow-x: auto;
	}

	.ul-rows {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.ul-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		flex-wrap: wrap;
	}

	.ul-text {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.ul-title {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		letter-spacing: var(--track-body);
		color: var(--text-default);
	}

	.ul-hint {
		font-size: var(--text-footnote);
		line-height: 1.4;
		color: var(--text-muted);
	}
</style>
