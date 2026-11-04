<script lang="ts">
	import { ActionRow, Button, Modal, SectionCard, SettingsList } from '$lib/components/ui';
	import SettingCommand from '$lib/components/setup/SettingCommand.svelte';
	import { settingChanges, type SettingChange } from '$lib/components/setup/setting-changes';
	import type { SetupOverview } from '$lib/components/setup/setup-overview';

	let { overview }: { overview: SetupOverview | null } = $props();

	const changes = $derived(settingChanges(overview));
	const valueOf = (id: string) => overview?.items.find((item) => item.id === id)?.value ?? null;
	const rows = $derived(
		[
			{ change: changes.dashboard, value: valueOf('dashboard') },
			{ change: changes.apps, value: valueOf('apps') },
			{ change: changes.mcp, value: valueOf('mcp') },
			{ change: changes.letsencrypt, value: null }
		].filter((row): row is { change: SettingChange; value: string | null } => !!row.change)
	);

	let open = $state<SettingChange | null>(null);
	let showing = $state(false);

	function show(change: SettingChange) {
		open = change;
		showing = true;
	}
</script>

{#if rows.length > 0}
	<SectionCard
		title="Addresses"
		description={overview?.installer
			? 'Change these with a command on the server.'
			: 'Change these in your Helm values.'}
	>
		<SettingsList label="Addresses">
			{#each rows as row (row.change.title)}
				<ActionRow label={row.change.title} hint={row.value}>
					<Button variant="secondary" size="sm" onclick={() => show(row.change)}>Change</Button>
				</ActionRow>
			{/each}
		</SettingsList>
	</SectionCard>

	<Modal bind:open={showing} title={open?.title ?? ''}>
		{#if open}
			<SettingCommand change={open} />
		{/if}
	</Modal>
{/if}
