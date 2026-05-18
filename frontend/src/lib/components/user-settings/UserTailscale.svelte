<script lang="ts">
	import { Loader2, Globe } from 'lucide-svelte';
	import SettingsSection from './SettingsSection.svelte';
	import StatusPill from './StatusPill.svelte';
	import IntegrationCard from './IntegrationCard.svelte';
	import ConnectPrompt from './ConnectPrompt.svelte';

	let {
		tailscaleLoading,
		tailscaleLinked,
		tailscaleTailnet,
		unlinkingTailscale,
		showTailscaleForm = $bindable(false),
		tailscaleApiKey = $bindable(''),
		linkingTailscale,
		onLink,
		onUnlink,
		index = 0,
	}: {
		tailscaleLoading: boolean;
		tailscaleLinked: boolean;
		tailscaleTailnet: string | null;
		unlinkingTailscale: boolean;
		showTailscaleForm: boolean;
		tailscaleApiKey: string;
		linkingTailscale: boolean;
		onLink: () => void;
		onUnlink: () => void;
		index?: number;
	} = $props();
</script>

<SettingsSection {index} title="Tailscale" description="Access your deployments on your private network">
	{#snippet icon(_hovered)}<Globe class="h-[18px] w-[18px]" />{/snippet}
	{#snippet badge()}
		{#if !tailscaleLoading}
			<StatusPill active={tailscaleLinked} label={tailscaleLinked ? 'Connected' : 'Not connected'} />
		{/if}
	{/snippet}

	{#if tailscaleLoading}
		<div class="ut-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
	{:else if tailscaleLinked}
		<IntegrationCard name={tailscaleTailnet ?? ''} disconnecting={unlinkingTailscale} onDisconnect={onUnlink}>
			{#snippet icon()}<Globe class="h-4 w-4" />{/snippet}
		</IntegrationCard>
	{:else if showTailscaleForm}
		<div class="ut-form">
			<div class="ut-instructions">
				<p class="ut-instructions-intro">Paste a Tailscale auth key below. To create one:</p>
				<ol class="ut-instructions-list">
					<li>Go to <a href="https://login.tailscale.com/admin/settings/keys" target="_blank" rel="noopener" class="ut-link">Tailscale Admin → Settings → Keys</a></li>
					<li>Click <strong>Generate auth key</strong></li>
					<li>Enable <strong>Reusable</strong> so it can be used for multiple deployments</li>
					<li>Set expiration to <strong>90 days</strong> (max)</li>
					<li>Enable <strong>Ephemeral</strong> so nodes auto-remove when deployments stop</li>
					<li>Leave <strong>Tags</strong> empty</li>
					<li>Click <strong>Generate key</strong>, copy it, and paste it here</li>
				</ol>
			</div>
			<div class="ut-input-row">
				<input
					type="password"
					class="ut-input"
					placeholder="tskey-auth-..."
					bind:value={tailscaleApiKey}
					onkeydown={(e) => { if (e.key === 'Enter') onLink(); }}
				/>
				<button onclick={() => { showTailscaleForm = false; tailscaleApiKey = ''; }} class="ut-btn ut-btn--ghost">Cancel</button>
				<button onclick={onLink} disabled={linkingTailscale || !tailscaleApiKey.trim()} class="ut-btn ut-btn--solid">
					{#if linkingTailscale}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
					Connect
				</button>
			</div>
		</div>
	{:else}
		<ConnectPrompt
			label="Connect Tailscale"
			hint="Expose deployments directly to your Tailscale network"
			onclick={() => (showTailscaleForm = true)}
		>
			{#snippet icon()}<Globe class="h-5 w-5" />{/snippet}
		</ConnectPrompt>
	{/if}
</SettingsSection>

<style>
	.ut-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem 0;
		color: var(--surface-muted);
	}
	.ut-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.ut-instructions {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.ut-instructions-intro {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0;
	}
	.ut-instructions-list {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0;
		padding-left: 1rem;
		list-style: decimal;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.ut-link {
		color: var(--button-bg);
		text-decoration: underline;
	}
	.ut-input-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.ut-input {
		flex: 1;
		padding: 0.4375rem 0.75rem;
		font-size: 0.8125rem;
		border: 1px solid var(--surface-border);
		border-radius: 0.5rem;
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		transition: border-color 150ms;
	}
	.ut-input:focus {
		outline: none;
		border-color: var(--sidebar-text-active-border);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
	}
	.ut-btn {
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
	.ut-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.ut-btn--solid {
		background-color: var(--button-bg);
		color: var(--button-color);
	}
	.ut-btn--solid:hover:not(:disabled) { opacity: 0.9; }
	.ut-btn--ghost {
		background: none;
		color: var(--surface-muted);
	}
	.ut-btn--ghost:hover:not(:disabled) {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--center-channel-color) 5%, transparent);
	}
</style>
