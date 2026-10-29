<script lang="ts">
	import { isSuperAdmin } from '$lib/stores';
	import { SectionCard, SegmentedControl, ToggleRow } from '$lib/components/ui';
	import SettingsList from '$lib/components/ui/SettingsList.svelte';
	import SettingRow from '$lib/components/ui/SettingRow.svelte';

	type Builder = '' | 'firecracker' | 'kubernetes';

	let {
		buildFromRoot = $bindable(false),
		buildWithDepot = $bindable(false),
		persistentBuildCache = $bindable(false),
		builderOverride = $bindable<Builder>(''),
		buildOptionsDirty = $bindable(false),
		onSave
	}: {
		buildFromRoot: boolean;
		buildWithDepot: boolean;
		persistentBuildCache: boolean;
		builderOverride?: Builder;
		buildOptionsDirty?: boolean;
		onSave: () => void | Promise<void>;
	} = $props();

	const BUILDERS = [
		{ value: '', label: 'Auto' },
		{ value: 'firecracker', label: 'On' },
		{ value: 'kubernetes', label: 'Off' }
	];

	let queue: Promise<void> = Promise.resolve();

	function commit(revert: () => void) {
		buildOptionsDirty = true;
		queue = queue.then(async () => {
			await onSave();
			if (buildOptionsDirty) {
				revert();
				buildOptionsDirty = false;
			}
		});
	}
</script>

<SectionCard title="Builder">
	<SettingsList>
		<ToggleRow
			label="Build from repository root"
			bind:checked={buildFromRoot}
			onchange={() => commit(() => (buildFromRoot = !buildFromRoot))}
		/>
		{#if $isSuperAdmin}
			<ToggleRow
				label="Persistent build cache"
				bind:checked={persistentBuildCache}
				onchange={() => commit(() => (persistentBuildCache = !persistentBuildCache))}
			/>
			<ToggleRow
				label="Orchard's super builds"
				bind:checked={buildWithDepot}
				onchange={() => commit(() => (buildWithDepot = !buildWithDepot))}
			/>
		{/if}
		<SettingRow label="Fast builder" hint="Auto lets Orchard decide">
			<SegmentedControl
				label="Fast builder"
				options={BUILDERS}
				bind:value={
					() => builderOverride,
					(next) => {
						const previous = builderOverride;
						builderOverride = next as Builder;
						commit(() => (builderOverride = previous));
					}
				}
			/>
		</SettingRow>
	</SettingsList>
</SectionCard>
