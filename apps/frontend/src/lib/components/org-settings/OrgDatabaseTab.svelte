<script lang="ts">
	import { Database } from 'lucide-svelte';
	import { Button, Field, Input } from '$lib/components/ui';
	import SettingsSection from '$lib/components/user-settings/SettingsSection.svelte';

	let {
		canEditOrg,
		publicIp = $bindable(''),
		publicIpSaving,
		onSavePublicIp,
		index = 0
	}: {
		canEditOrg: boolean;
		publicIp: string;
		publicIpSaving: boolean;
		onSavePublicIp: () => void;
		index?: number;
	} = $props();
</script>

<SettingsSection
	title="Public database IP"
	description="Shared external IP for public database exposure"
	{index}
>
	{#snippet icon(_hovered)}<Database class="h-[18px] w-[18px]" />{/snippet}

	{#if canEditOrg}
		<p class="od-hint">
			Shared external IP used to expose databases publicly. Databases opted into public exposure
			will share this IP with unique ports per database.
		</p>

		<Field label="IPv4 / IPv6 address" for="public-ip">
			<div class="od-input-row">
				<Input
					id="public-ip"
					class="od-ip-input"
					placeholder="e.g. 203.0.113.10"
					bind:value={publicIp}
				/>
				<Button variant="primary" onclick={onSavePublicIp} loading={publicIpSaving}>Save</Button>
			</div>
		</Field>
	{:else}
		<p class="od-no-access">Only admins and owners can manage database settings.</p>
	{/if}
</SettingsSection>

<style>
	.od-hint {
		font-size: var(--text-caption);
		color: var(--surface-muted);
		margin: 0 0 1rem;
		line-height: 1.5;
	}
	.od-input-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.od-input-row :global(.od-ip-input) {
		flex: 1;
	}
	.od-no-access {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--surface-muted);
		margin: 0;
	}
</style>
