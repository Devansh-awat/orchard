<script lang="ts">
	import { Loader2, Globe } from 'lucide-svelte';
	import { Button, Input, StatusBadge, statusMeta } from '$lib/components/ui';
	import SettingsSection from './SettingsSection.svelte';
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
		index = 0
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

<SettingsSection {index} title="Tailscale" description="Access your apps on your private network">
	{#snippet icon(_hovered)}<Globe class="h-[18px] w-[18px]" />{/snippet}
	{#snippet badge()}
		{#if !tailscaleLoading}
			<StatusBadge
				meta={statusMeta(
					tailscaleLinked ? 'success' : 'neutral',
					tailscaleLinked ? 'Connected' : 'Not connected'
				)}
			/>
		{/if}
	{/snippet}

	{#if tailscaleLoading}
		<div class="ut-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
	{:else if tailscaleLinked}
		<IntegrationCard
			name={tailscaleTailnet ?? ''}
			disconnecting={unlinkingTailscale}
			onDisconnect={onUnlink}
		>
			{#snippet icon()}<Globe class="h-4 w-4" />{/snippet}
		</IntegrationCard>
	{:else if showTailscaleForm}
		<div class="ut-form">
			<div class="ut-instructions">
				<p class="ut-instructions-intro">Paste a Tailscale auth key below. To create one:</p>
				<ol class="ut-instructions-list">
					<li>
						Go to <a
							href="https://login.tailscale.com/admin/settings/keys"
							target="_blank"
							rel="noopener"
							class="ut-link">Tailscale Admin → Settings → Keys</a
						>
					</li>
					<li>Click <strong>Generate auth key</strong></li>
					<li>Enable <strong>Reusable</strong> so it can be used for multiple apps</li>
					<li>Set expiration to <strong>90 days</strong> (max)</li>
					<li>Enable <strong>Ephemeral</strong> so nodes auto-remove when deployments stop</li>
					<li>Leave <strong>Tags</strong> empty</li>
					<li>Click <strong>Generate key</strong>, copy it, and paste it here</li>
				</ol>
			</div>
			<div class="ut-input-row">
				<div class="ut-input-wrap">
					<Input
						type="password"
						placeholder="tskey-auth-..."
						bind:value={tailscaleApiKey}
						onkeydown={(e: KeyboardEvent) => {
							if (e.key === 'Enter') onLink();
						}}
					/>
				</div>
				<Button
					variant="ghost"
					size="sm"
					onclick={() => {
						showTailscaleForm = false;
						tailscaleApiKey = '';
					}}>Cancel</Button
				>
				<Button
					variant="primary"
					size="sm"
					onclick={onLink}
					loading={linkingTailscale}
					disabled={!tailscaleApiKey.trim()}
				>
					Connect
				</Button>
			</div>
		</div>
	{:else}
		<ConnectPrompt label="Connect Tailscale" onclick={() => (showTailscaleForm = true)}>
			{#snippet icon()}<Globe class="h-5 w-5" />{/snippet}
		</ConnectPrompt>
	{/if}
</SettingsSection>

<style>
	.ut-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-6) 0;
		color: var(--text-muted);
	}
	.ut-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.ut-instructions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.ut-instructions-intro {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		margin: 0;
	}
	.ut-instructions-list {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		margin: 0;
		padding-left: var(--space-4);
		list-style: decimal;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.ut-link {
		color: var(--accent);
		text-decoration: underline;
	}
	.ut-input-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.ut-input-wrap {
		flex: 1;
		min-width: 0;
	}
</style>
