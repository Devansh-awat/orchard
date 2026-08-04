<script lang="ts">
	import { Loader2, Building2 } from 'lucide-svelte';
	import { MailCheck } from '@jis3r/icons';
	import type { PendingInvitation } from '$lib/stores';
	import { pendingInvitations } from '$lib/stores';
	import { Button } from '$lib/components/ui';
	import SettingsSection from './SettingsSection.svelte';

	let {
		invitations,
		acceptingInvitation,
		decliningInvitation,
		onAccept,
		onDecline,
		index = 0
	}: {
		invitations: PendingInvitation[];
		acceptingInvitation: string | null;
		decliningInvitation: string | null;
		onAccept: (invitation: PendingInvitation) => void;
		onDecline: (invitation: PendingInvitation) => void;
		index?: number;
	} = $props();
</script>

{#if invitations.length > 0}
	<SettingsSection
		{index}
		title="Pending invitations"
		description="{invitations.length} organization{invitations.length === 1 ? '' : 's'} invited you"
	>
		{#snippet icon(hovered)}<MailCheck size={18} animate={hovered} />{/snippet}
		{#snippet badge()}
			<span class="ui-count">{invitations.length}</span>
		{/snippet}

		<div class="ui-list" id="invitations">
			{#each invitations as invitation (invitation.id)}
				<div class="ui-item">
					<div class="ui-item-icon">
						{#if invitation.organization.avatarUrl}
							<img
								src={invitation.organization.avatarUrl}
								alt={invitation.organization.name}
								class="ui-item-avatar"
							/>
						{:else}
							<Building2 class="h-5 w-5" />
						{/if}
					</div>
					<div class="ui-item-body">
						<span class="ui-item-name">{invitation.organization.name}</span>
						<span class="ui-item-meta">
							Invited by {pendingInvitations.getInviterName(invitation.inviter)} · {invitation.role}
						</span>
					</div>
					<div class="ui-item-actions">
						<Button
							variant="ghost"
							size="sm"
							onclick={() => onDecline(invitation)}
							disabled={acceptingInvitation !== null || decliningInvitation !== null}
						>
							{#if decliningInvitation === invitation.token}<Loader2
									class="h-3.5 w-3.5 animate-spin"
								/>{/if}
							Decline
						</Button>
						<Button
							variant="primary"
							size="sm"
							onclick={() => onAccept(invitation)}
							disabled={acceptingInvitation !== null || decliningInvitation !== null}
						>
							{#if acceptingInvitation === invitation.token}<Loader2
									class="h-3.5 w-3.5 animate-spin"
								/>{/if}
							Accept
						</Button>
					</div>
				</div>
			{/each}
		</div>
	</SettingsSection>
{/if}

<style>
	.ui-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.5rem;
		border-radius: var(--radius-pill);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		background-color: var(--accent-subtle);
		color: var(--accent);
	}
	.ui-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.ui-item {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		padding: 0.875rem var(--space-4);
		border-radius: var(--radius-md);
		background-color: var(--fill-quiet);
	}
	.ui-item-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--radius-md);
		flex-shrink: 0;
		background-color: var(--accent-subtle);
		color: var(--accent);
		overflow: hidden;
	}
	.ui-item-avatar {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.ui-item-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.ui-item-name {
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: 600;
		letter-spacing: var(--track-body);
		color: var(--text-default);
	}
	.ui-item-meta {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-muted);
	}
	.ui-item-actions {
		display: flex;
		gap: 0.5rem;
		flex-shrink: 0;
	}
	@media (max-width: 640px) {
		.ui-item {
			flex-wrap: wrap;
		}
		.ui-item-actions {
			width: 100%;
			margin-top: var(--space-1);
		}
	}
</style>
