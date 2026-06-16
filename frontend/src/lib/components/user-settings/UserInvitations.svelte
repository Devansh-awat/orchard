<script lang="ts">
	import { Loader2, Building2 } from 'lucide-svelte';
	import { MailCheck } from '@jis3r/icons';
	import type { PendingInvitation } from '$lib/stores';
	import { pendingInvitations } from '$lib/stores';
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
		title="Pending Invitations"
		description="{invitations.length} organization{invitations.length === 1 ? '' : 's'} invited you"
		iconColor="blue"
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
						<button
							class="ui-btn ui-btn--ghost"
							onclick={() => onDecline(invitation)}
							disabled={acceptingInvitation !== null || decliningInvitation !== null}
						>
							{#if decliningInvitation === invitation.token}<Loader2
									class="h-3.5 w-3.5 animate-spin"
								/>{/if}
							Decline
						</button>
						<button
							class="ui-btn ui-btn--solid"
							onclick={() => onAccept(invitation)}
							disabled={acceptingInvitation !== null || decliningInvitation !== null}
						>
							{#if acceptingInvitation === invitation.token}<Loader2
									class="h-3.5 w-3.5 animate-spin"
								/>{/if}
							Accept
						</button>
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
		padding: 0 0.375rem;
		border-radius: 2rem;
		font-size: 0.6875rem;
		font-weight: 650;
		background-color: color-mix(in srgb, var(--button-bg) 10%, transparent);
		color: var(--button-bg);
	}
	.ui-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.ui-item {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		padding: 0.875rem 1rem;
		border-radius: 0.625rem;
		background-color: color-mix(in srgb, var(--center-channel-color) 2%, transparent);
	}
	.ui-item-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.625rem;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--button-bg) 8%, transparent);
		color: var(--button-bg);
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
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}
	.ui-item-meta {
		font-size: 0.6875rem;
		color: var(--surface-muted);
	}
	.ui-item-actions {
		display: flex;
		gap: 0.375rem;
		flex-shrink: 0;
	}
	.ui-btn {
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
	.ui-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.ui-btn--solid {
		background-color: var(--button-bg);
		color: var(--button-color);
	}
	.ui-btn--solid:hover:not(:disabled) {
		opacity: 0.9;
	}
	.ui-btn--ghost {
		background: none;
		color: var(--surface-muted);
	}
	.ui-btn--ghost:hover:not(:disabled) {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--center-channel-color) 5%, transparent);
	}
	@media (max-width: 640px) {
		.ui-item {
			flex-wrap: wrap;
		}
		.ui-item-actions {
			width: 100%;
			margin-top: 0.25rem;
		}
	}
</style>
