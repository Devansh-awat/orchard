<script lang="ts">
	import {
		Button,
		SectionCard,
		SegmentedControl,
		SettingRow,
		SettingsList,
		ToggleRow
	} from '$lib/components/ui';
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

	let { index: _index = 0 }: { index?: number } = $props();

	const CLOCK_OPTIONS: { value: LogClock; label: string; hint: string }[] = [
		{ value: 'system', label: 'System', hint: 'Follows the clock format of your locale' },
		{ value: '12', label: '12 hour', hint: 'Times read 08:16:07 PM' },
		{ value: '24', label: '24 hour', hint: 'Times read 20:16:07' }
	];

	const ZONE_OPTIONS: { value: LogZone; label: string; hint: string }[] = [
		{ value: 'local', label: 'Local', hint: 'Your own time zone' },
		{ value: 'utc', label: 'UTC', hint: 'Matches the time zone in the server logs' }
	];

	const DATE_OPTIONS: { value: LogDate; label: string; hint: string }[] = [
		{ value: 'auto', label: 'When it changes', hint: "On lines that aren't from today" },
		{ value: 'always', label: 'Always', hint: 'Every line shows its date' },
		{ value: 'never', label: 'Never', hint: 'Times only' }
	];

	const ESC = '\u001b';

	const clockHint = $derived(CLOCK_OPTIONS.find((o) => o.value === logDisplay.clock)?.hint ?? '');
	const zoneHint = $derived(ZONE_OPTIONS.find((o) => o.value === logDisplay.zone)?.hint ?? '');
	const dateHint = $derived(DATE_OPTIONS.find((o) => o.value === logDisplay.date)?.hint ?? '');
	const isDefault = $derived(isLogDisplayDefault());

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

<SectionCard title="Timestamps" description="Hover a timestamp in any log for the full detail.">
	{#snippet actions()}
		<Button variant="ghost" size="sm" disabled={isDefault} onclick={resetLogDisplay}>Reset</Button>
	{/snippet}

	<SettingsList>
		<pre class="preview" aria-label="Preview">{@html sample}</pre>
		<SettingRow label="Clock" hint={clockHint}>
			<SegmentedControl
				options={CLOCK_OPTIONS}
				value={logDisplay.clock}
				label="Clock"
				onchange={(v) => setLogDisplay('clock', v as LogClock)}
			/>
		</SettingRow>
		<SettingRow label="Time zone" hint={zoneHint}>
			<SegmentedControl
				options={ZONE_OPTIONS}
				value={logDisplay.zone}
				label="Time zone"
				onchange={(v) => setLogDisplay('zone', v as LogZone)}
			/>
		</SettingRow>
		<SettingRow label="Date" hint={dateHint}>
			<SegmentedControl
				options={DATE_OPTIONS}
				value={logDisplay.date}
				label="Date"
				onchange={(v) => setLogDisplay('date', v as LogDate)}
			/>
		</SettingRow>
		<ToggleRow
			label="Milliseconds"
			hint="Useful for reading latency"
			bind:checked={() => logDisplay.milliseconds, (on) => setLogDisplay('milliseconds', on)}
		/>
	</SettingsList>
</SectionCard>

<style>
	.preview {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		line-height: 1.7;
		color: var(--text-default);
		white-space: pre-wrap;
		word-break: break-all;
	}
</style>
