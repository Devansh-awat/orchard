<script lang="ts">
	import { Building2 } from 'lucide-svelte';
	import type { PendingInvitation } from '$lib/stores';
	import { pendingInvitations } from '$lib/stores';
	import { Button, List, ListRow, SectionCard, ToneTile } from '$lib/components/ui';
	import RemoteImg from '$lib/components/ui/RemoteImg.svelte';

	let {
		invitations,
		acceptingInvitation,
		decliningInvitation,
		onAccept,
		onDecline
	}: {
		invitations: PendingInvitation[];
		acceptingInvitation: string | null;
		decliningInvitation: string | null;
		onAccept: (invitation: PendingInvitation) => void;
		onDecline: (invitation: PendingInvitation) => void;
		index?: number;
	} = $props();

	let broken = $state<Record<string, boolean>>({});

	const busy = $derived(acceptingInvitation !== null || decliningInvitation !== null);
</script>

{#if invitations.length > 0}
	<SectionCard title="Invitations">
		<List inset={false} label="Pending invitations">
			{#each invitations as invitation (invitation.id)}
				<ListRow
					flush
					pinned
					presence
					title={invitation.organization.name}
					subtitle="Invited by {pendingInvitations.getInviterName(
						invitation.inviter
					)} as {invitation.role}"
				>
					{#snippet leading()}
						<ToneTile size={32}>
							{#if invitation.organization.avatarUrl && !broken[invitation.id]}
								<RemoteImg
									src={invitation.organization.avatarUrl}
									style="width: 100%; height: 100%; object-fit: cover;"
									onerror={() => (broken[invitation.id] = true)}
								/>
							{:else}
								<Building2 size={16} />
							{/if}
						</ToneTile>
					{/snippet}
					{#snippet actions()}
						<Button
							size="sm"
							variant="ghost"
							loading={decliningInvitation === invitation.token}
							disabled={busy}
							onclick={() => onDecline(invitation)}>Decline</Button
						>
						<Button
							size="sm"
							variant="primary"
							loading={acceptingInvitation === invitation.token}
							disabled={busy}
							onclick={() => onAccept(invitation)}>Accept</Button
						>
					{/snippet}
				</ListRow>
			{/each}
		</List>
	</SectionCard>
{/if}
