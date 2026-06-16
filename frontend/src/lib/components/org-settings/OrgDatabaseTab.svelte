<script lang="ts">
	import { Loader2, Database } from 'lucide-svelte';
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
	title="Public Database IP"
	description="Shared external IP for public database exposure"
	iconColor="green"
	{index}
>
	{#snippet icon(_hovered)}<Database class="h-[18px] w-[18px]" />{/snippet}

	{#if canEditOrg}
		<p class="od-hint">
			Shared external IP used to expose databases publicly. Databases opted into public exposure
			will share this IP with unique ports per database.
		</p>

		<div class="od-field">
			<label class="od-field-label" for="public-ip">IPv4 / IPv6 Address</label>
			<div class="od-input-row">
				<input
					id="public-ip"
					type="text"
					class="od-input"
					placeholder="e.g. 203.0.113.10"
					bind:value={publicIp}
				/>
				<button onclick={onSavePublicIp} disabled={publicIpSaving} class="od-btn od-btn--solid">
					{#if publicIpSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
					Save
				</button>
			</div>
		</div>
	{:else}
		<p class="od-no-access">Only admins and owners can manage database settings.</p>
	{/if}
</SettingsSection>

<style>
	.od-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0 0 1rem;
		line-height: 1.5;
	}
	.od-field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.od-field-label {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}
	.od-input-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.od-input {
		flex: 1;
		padding: 0.4375rem 0.75rem;
		font-size: 0.8125rem;
		border: 1px solid var(--surface-border);
		border-radius: 0.5rem;
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		transition: border-color 150ms;
	}
	.od-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
	}
	.od-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 550;
		border: none;
		cursor: pointer;
		transition: all 120ms;
		white-space: nowrap;
	}
	.od-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.od-btn--solid {
		background-color: var(--button-bg);
		color: var(--button-color);
	}
	.od-btn--solid:hover:not(:disabled) {
		opacity: 0.9;
	}
	.od-no-access {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0;
	}
</style>
