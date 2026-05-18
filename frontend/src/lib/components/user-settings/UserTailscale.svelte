<script lang="ts">
	import { Loader2, Globe, Unlink, ChevronRight } from 'lucide-svelte';

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
	} = $props();
</script>

<div class="us-card-section">
	<div class="us-section-head">
		<div class="us-section-icon us-section-icon--tailscale">
			<Globe class="h-4 w-4" />
		</div>
		<div class="us-section-title-group">
			<h2 class="us-section-title">Tailscale</h2>
			<p class="us-section-desc">Access your deployments on your private network</p>
		</div>
		{#if !tailscaleLoading}
			<div class="us-pill" class:us-pill--active={tailscaleLinked}>
				<span class="us-pill-dot"></span>
				{tailscaleLinked ? 'Connected' : 'Not connected'}
			</div>
		{/if}
	</div>

	{#if tailscaleLoading}
		<div class="us-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
	{:else if tailscaleLinked}
		<div class="us-integration-row">
			<div class="us-gh-badge">
				<Globe class="h-4 w-4" />
				<span class="us-gh-name">{tailscaleTailnet}</span>
			</div>
			<button onclick={onUnlink} disabled={unlinkingTailscale} class="us-btn us-btn-danger">
				{#if unlinkingTailscale}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Unlink class="h-3.5 w-3.5" />{/if}
				Disconnect
			</button>
		</div>
	{:else if showTailscaleForm}
		<div class="space-y-3">
			<div class="space-y-1.5">
				<p class="text-xs" style="color: var(--surface-muted);">
					Paste a Tailscale auth key below. To create one:
				</p>
				<ol class="text-xs space-y-1 pl-4" style="color: var(--surface-muted); list-style: decimal;">
					<li>Go to <a href="https://login.tailscale.com/admin/settings/keys" target="_blank" rel="noopener" class="underline" style="color: var(--button-bg);">Tailscale Admin → Settings → Keys</a></li>
					<li>Click <strong>Generate auth key</strong></li>
					<li>Enable <strong>Reusable</strong> so it can be used for multiple deployments</li>
					<li>Set expiration to <strong>90 days</strong> (max)</li>
					<li>Enable <strong>Ephemeral</strong> so nodes auto-remove when deployments stop</li>
					<li>Leave <strong>Tags</strong> empty</li>
					<li>Click <strong>Generate key</strong>, copy it, and paste it here</li>
				</ol>
			</div>
			<div class="flex items-center gap-2">
				<input
					type="password"
					class="input text-sm flex-1"
					placeholder="tskey-auth-..."
					bind:value={tailscaleApiKey}
					onkeydown={(e) => { if (e.key === 'Enter') onLink(); }}
				/>
				<button onclick={() => { showTailscaleForm = false; tailscaleApiKey = ''; }} class="btn btn-secondary btn-sm">Cancel</button>
				<button onclick={onLink} disabled={linkingTailscale || !tailscaleApiKey.trim()} class="btn btn-primary btn-sm">
					{#if linkingTailscale}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
					Connect
				</button>
			</div>
		</div>
	{:else}
		<button onclick={() => (showTailscaleForm = true)} class="us-connect-btn">
			<div class="us-connect-icon us-section-icon--tailscale">
				<Globe class="h-5 w-5" />
			</div>
			<div class="us-connect-text">
				<span class="us-connect-label">Connect Tailscale</span>
				<span class="us-connect-hint">Expose deployments directly to your Tailscale network</span>
			</div>
			<ChevronRight class="h-4 w-4 us-connect-arrow" />
		</button>
	{/if}
</div>
