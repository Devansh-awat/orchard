<script lang="ts">
	import {
		ActionRow,
		Button,
		FormActions,
		Input,
		SectionCard,
		SettingRow,
		SettingsList,
		Switch
	} from '$lib/components/ui';

	let {
		canEditOrg,
		publicIp = $bindable(''),
		publicIpSaving,
		instanceDefaultPublicIp = null,
		onSavePublicIp,
		postgresAutoUpdate,
		postgresAutoUpdateAllowed = true,
		postgresAutoUpdateSaving = false,
		onTogglePostgresAutoUpdate
	}: {
		canEditOrg: boolean;
		publicIp: string;
		publicIpSaving: boolean;
		instanceDefaultPublicIp?: string | null;
		onSavePublicIp: () => void;
		postgresAutoUpdate: boolean;
		postgresAutoUpdateAllowed?: boolean;
		postgresAutoUpdateSaving?: boolean;
		onTogglePostgresAutoUpdate: (enabled: boolean) => void;
		index?: number;
	} = $props();

	const autoHint = $derived(
		!postgresAutoUpdateAllowed
			? 'Turned off for this whole instance by its operator.'
			: postgresAutoUpdate
				? 'Orchard moves databases to the newest minor release a few at a time each morning (UTC), restarting instances one at a time.'
				: 'Databases stay on their current release until someone updates them from the Security tab.'
	);
</script>

<SectionCard title="Postgres updates">
	{#if canEditOrg}
		<SettingsList>
			<ActionRow label="Apply minor updates automatically" hint={autoHint}>
				<Switch
					label="Apply minor updates automatically"
					checked={postgresAutoUpdate}
					disabled={!postgresAutoUpdateAllowed || postgresAutoUpdateSaving}
					onchange={onTogglePostgresAutoUpdate}
				/>
			</ActionRow>
		</SettingsList>
	{:else}
		<p class="quiet">Only admins and owners can change this.</p>
	{/if}
</SectionCard>

<SectionCard title="Public database IP">
	{#if canEditOrg}
		<form
			onsubmit={(e) => {
				e.preventDefault();
				onSavePublicIp();
			}}
		>
			<SettingsList>
				<SettingRow
					label="Address"
					for="public-ip"
					hint="Public databases share it, each on its own port"
					wide
				>
					<Input
						id="public-ip"
						mono
						placeholder={instanceDefaultPublicIp || '203.0.113.10'}
						bind:value={publicIp}
						autocomplete="off"
						spellcheck="false"
					/>
				</SettingRow>
			</SettingsList>
			<div class="save">
				<FormActions
					hint={instanceDefaultPublicIp
						? `Leave it blank to use this instance's default, ${instanceDefaultPublicIp}`
						: undefined}
				>
					<Button type="submit" variant="primary" loading={publicIpSaving}>Save</Button>
				</FormActions>
			</div>
		</form>
	{:else}
		<p class="quiet">Only admins and owners can change this.</p>
	{/if}
</SectionCard>

<style>
	.save {
		margin-top: var(--space-4);
	}
	.quiet {
		margin: 0;
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
</style>
