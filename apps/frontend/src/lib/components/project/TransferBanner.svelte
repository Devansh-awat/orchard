<script lang="ts">
	import { Check, Crown, X } from 'lucide-svelte';
	import { Alert, Button } from '$lib/components/ui';
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
	const expires = $derived(
		new Date(transfer.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
	);
</script>

<Alert
	tone="info"
	title={isRecipient
		? `${transferPartyName(transfer.from)} wants to hand you this project`
		: `Waiting on ${transferPartyName(transfer.to)} to take ownership`}
>
	{#snippet icon()}<Crown size={16} />{/snippet}
	{#if isRecipient}
		Accepting makes you a project admin and counts everything here against your allowance. Expires {expires}.
	{:else}
		Nothing changes until they accept. Expires {expires}.
	{/if}
	{#snippet actions()}
		{#if isRecipient}
			<Button
				size="sm"
				icon={X}
				loading={declining}
				disabled={busy && !declining}
				onclick={() => ondecline?.()}
			>
				Decline
			</Button>
			<Button
				size="sm"
				variant="primary"
				icon={Check}
				loading={accepting}
				disabled={busy && !accepting}
				onclick={() => onaccept?.()}
			>
				Accept
			</Button>
		{:else if canCancel}
			<Button
				size="sm"
				loading={canceling}
				disabled={busy && !canceling}
				onclick={() => oncancel?.()}
			>
				Cancel request
			</Button>
		{/if}
	{/snippet}
</Alert>
