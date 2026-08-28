<script lang="ts">
	import { Crown, Loader2, Check, X } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { type PendingTransfer, transferPartyName } from './types';

	let {
		transfer,
		isRecipient = false,
		canCancel = false,
		accepting = false,
		declining = false,
		canceling = false,
		onaccept,
		ondecline,
		oncancel
	}: {
		transfer: PendingTransfer;
		isRecipient?: boolean;
		canCancel?: boolean;
		accepting?: boolean;
		declining?: boolean;
		canceling?: boolean;
		onaccept?: () => void;
		ondecline?: () => void;
		oncancel?: () => void;
	} = $props();

	const busy = $derived(accepting || declining || canceling);
	const expires = $derived(new Date(transfer.expiresAt).toLocaleDateString());
</script>

<div class="tb" {@attach motionStagger({ index: 0, from: { y: -10 } })}>
	<span class="tb-icon"><Crown size={16} /></span>
	<div class="tb-text">
		{#if isRecipient}
			<p class="tb-title">
				{transferPartyName(transfer.from)} wants you to take ownership of this project
			</p>
			<p class="tb-body">
				Accepting bills every app and database here against your resource allowance and makes you a
				project admin. Expires {expires}.
			</p>
		{:else}
			<p class="tb-title">
				Ownership transfer to {transferPartyName(transfer.to)} is waiting on them
			</p>
			<p class="tb-body">
				Nothing moves until they accept. The request expires {expires}.
			</p>
		{/if}
	</div>
	<div class="tb-actions">
		{#if isRecipient}
			<Button variant="secondary" size="sm" disabled={busy} onclick={() => ondecline?.()}>
				{#if declining}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<X
						class="h-3.5 w-3.5"
					/>{/if}
				Decline
			</Button>
			<Button variant="primary" size="sm" disabled={busy} onclick={() => onaccept?.()}>
				{#if accepting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Check
						class="h-3.5 w-3.5"
					/>{/if}
				Accept
			</Button>
		{:else if canCancel}
			<Button variant="secondary" size="sm" disabled={busy} onclick={() => oncancel?.()}>
				{#if canceling}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
				Cancel request
			</Button>
		{/if}
	</div>
</div>

<style>
	.tb {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		margin-bottom: var(--space-4);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--accent) 8%, var(--bg-surface));
		border: 1px solid color-mix(in srgb, var(--accent) 26%, transparent);
	}
	.tb-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 50%;
		flex-shrink: 0;
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
	}
	.tb-text {
		flex: 1;
		min-width: 0;
	}
	.tb-title {
		margin: 0;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
	}
	.tb-body {
		margin: 0.15rem 0 0;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
	}
	.tb-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-shrink: 0;
	}
</style>
