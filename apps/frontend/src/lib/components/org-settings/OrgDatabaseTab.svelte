<script lang="ts">
	import {
		Button,
		FormActions,
		Input,
		SectionCard,
		SettingRow,
		SettingsList
	} from '$lib/components/ui';

	let {
		canEditOrg,
		publicIp = $bindable(''),
		publicIpSaving,
		instanceDefaultPublicIp = null,
		onSavePublicIp
	}: {
		canEditOrg: boolean;
		publicIp: string;
		publicIpSaving: boolean;
		instanceDefaultPublicIp?: string | null;
		onSavePublicIp: () => void;
		index?: number;
	} = $props();
</script>

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
