<script lang="ts">
	import { Loader2, Mail, Building2 } from 'lucide-svelte';
	import type { PendingInvitation } from '$lib/stores';
	import { pendingInvitations } from '$lib/stores';

	let {
		invitations,
		acceptingInvitation,
		decliningInvitation,
		onAccept,
		onDecline,
	}: {
		invitations: PendingInvitation[];
		acceptingInvitation: string | null;
		decliningInvitation: string | null;
		onAccept: (invitation: PendingInvitation) => void;
		onDecline: (invitation: PendingInvitation) => void;
	} = $props();
</script>

{#if invitations.length > 0}
	<div class="us-card-divider"></div>

	<div class="us-card-section" id="invitations">
		<div class="us-section-head">
			<div class="us-section-icon us-section-icon--invitations">
				<Mail class="h-4 w-4" />
			</div>
			<div class="us-section-title-group">
				<h2 class="us-section-title">Pending Invitations</h2>
				<p class="us-section-desc">{invitations.length} organization{invitations.length === 1 ? '' : 's'} invited you</p>
			</div>
			<span class="us-count">{invitations.length}</span>
		</div>

		<div class="us-invitations-list">
			{#each invitations as invitation (invitation.id)}
				<div class="us-invitation">
					<div class="us-invitation-icon">
						{#if invitation.organization.avatarUrl}
							<img src={invitation.organization.avatarUrl} alt={invitation.organization.name} class="us-invitation-avatar" />
						{:else}
							<Building2 class="h-5 w-5" />
						{/if}
					</div>
					<div class="us-invitation-body">
						<span class="us-invitation-name">{invitation.organization.name}</span>
						<span class="us-invitation-meta">
							Invited by {pendingInvitations.getInviterName(invitation.inviter)} · {invitation.role}
						</span>
					</div>
					<div class="us-invitation-actions">
						<button
							class="us-btn us-btn-ghost"
							onclick={() => onDecline(invitation)}
							disabled={acceptingInvitation !== null || decliningInvitation !== null}
						>
							{#if decliningInvitation === invitation.token}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
							Decline
						</button>
						<button
							class="us-btn us-btn-solid"
							onclick={() => onAccept(invitation)}
							disabled={acceptingInvitation !== null || decliningInvitation !== null}
						>
							{#if acceptingInvitation === invitation.token}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
							Accept
						</button>
					</div>
				</div>
			{/each}
		</div>
	</div>
{/if}
