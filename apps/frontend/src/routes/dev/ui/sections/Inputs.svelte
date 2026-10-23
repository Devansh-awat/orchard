<script lang="ts">
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import Input from '$lib/components/ui/Input.svelte';
	import SearchField from '$lib/components/ui/SearchField.svelte';
	import Field from '$lib/components/ui/Field.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import Switch from '$lib/components/ui/Switch.svelte';
	import ToggleRow from '$lib/components/ui/ToggleRow.svelte';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';

	let seg = $state('day');
	let on = $state(true);
	let autoDeploy = $state(false);
	let name = $state('hackclub-site');
	let region = $state('fsn1');
</script>

<SectionCard title="Inputs">
	<div class="grid grid-cols-3 gap-4">
		<Field label="App name" hint="Lowercase letters, numbers and dashes." for="g-name">
			<Input id="g-name" bind:value={name} />
		</Field>
		<Field label="Search">
			<SearchField placeholder="Search apps" shortcut="/" />
		</Field>
		<Field label="Domain" error="That domain is already taken." for="g-domain">
			<Input id="g-domain" value="hackclub.com" error />
		</Field>
		<Field label="Region" for="g-region">
			<Select id="g-region" bind:value={region}>
				<option value="fsn1">Falkenstein</option>
				<option value="hel1">Helsinki</option>
				<option value="ash">Ashburn</option>
			</Select>
		</Field>
		<Field label="Range">
			<SegmentedControl
				label="Range"
				bind:value={seg}
				options={[
					{ value: 'hour', label: '1h' },
					{ value: 'day', label: '24h' },
					{ value: 'week', label: '7d' },
					{ value: 'month', label: '30d' }
				]}
			/>
		</Field>
		<Field label="Switch">
			<div class="flex items-center gap-3">
				<Switch bind:checked={on} label="Enabled" />
				<Switch disabled />
			</div>
		</Field>
	</div>
	<div class="mt-4 flex flex-col gap-4">
		<ToggleRow
			label="Deploy on push"
			hint="Every push to main builds and ships."
			bind:checked={autoDeploy}
		/>
	</div>
</SectionCard>
