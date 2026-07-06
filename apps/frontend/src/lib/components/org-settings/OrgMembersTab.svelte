<script lang="ts">
	import { Loader2, UserPlus, Trash2, ChevronDown, Check, Mail, X } from 'lucide-svelte';
	import { UsersRound, MailCheck } from '@jis3r/icons';
	import { motionStagger, springHover } from '$lib/utils/motion.svelte';
	import { Button, Badge, Menu, MenuItem } from '$lib/components/ui';
	import SettingsSection from '$lib/components/user-settings/SettingsSection.svelte';

	interface Member {
		id: string;
		role: 'owner' | 'admin' | 'member' | 'guest';
		user: {
			id: string;
			firstName?: string;
			lastName?: string;
			email: string;
			imageUrl?: string;
			username?: string;
		};
	}

	interface Invitation {
		id: string;
		email: string;
		role: 'owner' | 'admin' | 'member' | 'guest';
		createdAt: string;
		expiresAt: string;
		inviter: {
			firstName?: string;
			lastName?: string;
			username?: string;
			email: string;
		};
	}

	let {
		members,
		invitations,
		canInvite,
		isOwner,
		newMemberEmail = $bindable(''),
		newMemberRole = $bindable<'member' | 'admin' | 'owner'>('member'),
		addingMember,
		resendingInvitationId,
		cancellingInvitationId,
		removingMemberId = null,
		onAddMember,
		onRemoveMember,
		onUpdateMemberRole,
		onResendInvitation,
		onCancelInvitation,
		index = 0
	}: {
		members: Member[];
		invitations: Invitation[];
		canInvite: boolean;
		isOwner: boolean;
		newMemberEmail: string;
		newMemberRole: 'member' | 'admin' | 'owner';
		addingMember: boolean;
		resendingInvitationId: string | null;
		cancellingInvitationId: string | null;
		removingMemberId?: string | null;
		onAddMember: () => void;
		onRemoveMember: (memberId: string) => void;
		onUpdateMemberRole: (memberId: string, role: 'owner' | 'admin' | 'member' | 'guest') => void;
		onResendInvitation: (id: string) => void;
		onCancelInvitation: (id: string) => void;
		index?: number;
	} = $props();

	const roleOptions: Array<{ value: 'member' | 'admin' | 'owner'; label: string }> = [
		{ value: 'member', label: 'Member' },
		{ value: 'admin', label: 'Admin' },
		{ value: 'owner', label: 'Owner' }
	];

	function formatRole(role: string) {
		return role.charAt(0).toUpperCase() + role.slice(1);
	}
</script>

<SettingsSection title="Members" description="Manage team access" iconColor="blue" {index}>
	{#snippet icon(hovered)}<UsersRound size={18} animate={hovered} />{/snippet}
	{#snippet badge()}<span class="om-count">{members.length}</span>{/snippet}

	{#if canInvite}
		<div class="om-invite-bar">
			<input
				type="email"
				bind:value={newMemberEmail}
				placeholder="Email address"
				class="om-invite-input"
			/>
			<Menu placement="bottom-end">
				{#snippet trigger(attrs, _open)}
					<button type="button" class="om-role-trigger" {...attrs} {@attach springHover()}>
						<span>{roleOptions.find((r) => r.value === newMemberRole)?.label || 'Role'}</span>
						<ChevronDown class="h-3.5 w-3.5" />
					</button>
				{/snippet}
				{#each roleOptions as option (option.value)}
					<MenuItem onclick={() => (newMemberRole = option.value)}>
						<span class="om-option-label">{option.label}</span>
						{#if newMemberRole === option.value}<Check class="h-3.5 w-3.5 om-check-icon" />{/if}
					</MenuItem>
				{/each}
			</Menu>
			<Button
				variant="primary"
				onclick={onAddMember}
				loading={addingMember}
				disabled={!newMemberEmail}
			>
				{#if !addingMember}<UserPlus class="h-4 w-4" />{/if}
				Invite
			</Button>
		</div>
	{/if}

	<div class="om-member-list">
		{#each members as member, i (member.user.id)}
			<div class="om-member" {@attach motionStagger({ index: i, stride: 0.03 })}>
				<div class="om-member-left">
					{#if member.user.imageUrl}
						<img
							src={member.user.imageUrl}
							alt={member.user.firstName || member.user.email}
							class="om-avatar"
						/>
					{:else}
						<div class="om-avatar-fallback">
							{member.user.firstName?.[0] || member.user.email[0].toUpperCase()}
						</div>
					{/if}
					<div class="om-member-info">
						<p class="om-member-name">
							{member.user.firstName || ''}
							{member.user.lastName || ''}
							{#if member.role === 'guest'}
								<span
									class="om-guest-wrap"
									title="Guests are only members of specific projects, not the whole organization"
									><Badge tone="warning">Guest</Badge></span
								>
							{/if}
						</p>
						<p class="om-member-email">{member.user.email}</p>
					</div>
				</div>
				<div class="om-member-right">
					{#if isOwner}
						<Menu placement="bottom-end">
							{#snippet trigger(attrs, _open)}
								<button type="button" class="om-role-trigger" {...attrs} {@attach springHover()}>
									<span>{formatRole(member.role)}</span>
									<ChevronDown class="h-3.5 w-3.5" />
								</button>
							{/snippet}
							{#each roleOptions as option (option.value)}
								<MenuItem onclick={() => onUpdateMemberRole(member.id, option.value)}>
									<span class="om-option-label">{option.label}</span>
									{#if member.role === option.value}<Check class="h-3.5 w-3.5 om-check-icon" />{/if}
								</MenuItem>
							{/each}
						</Menu>
					{:else}
						<Badge tone="neutral">{formatRole(member.role)}</Badge>
					{/if}
					{#if canInvite && member.role !== 'owner'}
						<Button
							variant="ghost"
							size="sm"
							onclick={() => onRemoveMember(member.id)}
							loading={removingMemberId === member.id}
							disabled={removingMemberId !== null}
							title="Remove member"
						>
							{#if removingMemberId !== member.id}<Trash2 class="h-3.5 w-3.5" />{/if}
						</Button>
					{/if}
				</div>
			</div>
		{/each}
	</div>
</SettingsSection>

{#if canInvite && invitations.length > 0}
	<SettingsSection
		title="Pending invitations"
		description="Invitations awaiting acceptance"
		iconColor="amber"
		index={index + 1}
	>
		{#snippet icon(hovered)}<MailCheck size={18} animate={hovered} />{/snippet}
		{#snippet badge()}<span class="om-count">{invitations.length}</span>{/snippet}

		<div class="om-member-list">
			{#each invitations as invitation, i (invitation.id)}
				<div class="om-member" {@attach motionStagger({ index: i, stride: 0.03 })}>
					<div class="om-member-left">
						<div class="om-avatar-fallback om-avatar-pending">
							<Mail class="h-3.5 w-3.5" />
						</div>
						<div class="om-member-info">
							<p class="om-member-name">{invitation.email}</p>
							<p class="om-member-email">
								Invited {new Date(invitation.createdAt).toLocaleDateString()} · Expires {new Date(
									invitation.expiresAt
								).toLocaleDateString()}
							</p>
						</div>
					</div>
					<div class="om-member-right">
						<Badge tone="neutral">{formatRole(invitation.role)}</Badge>
						<Button
							variant="ghost"
							size="sm"
							onclick={() => onResendInvitation(invitation.id)}
							disabled={resendingInvitationId === invitation.id}
							title="Resend"
						>
							{#if resendingInvitationId === invitation.id}<Loader2
									class="h-3.5 w-3.5 animate-spin"
								/>{:else}<Mail class="h-3.5 w-3.5" />{/if}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onclick={() => onCancelInvitation(invitation.id)}
							disabled={cancellingInvitationId === invitation.id}
							title="Cancel"
						>
							{#if cancellingInvitationId === invitation.id}<Loader2
									class="h-3.5 w-3.5 animate-spin"
								/>{:else}<X class="h-3.5 w-3.5" />{/if}
						</Button>
					</div>
				</div>
			{/each}
		</div>
	</SettingsSection>
{/if}

<style>
	.om-count {
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

	.om-invite-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding-bottom: 1rem;
		border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 40%, transparent);
		margin-bottom: 0.25rem;
	}

	.om-invite-input {
		flex: 1;
		min-width: 0;
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		outline: none;
		transition: border-color 120ms;
	}

	.om-invite-input:focus {
		border-color: var(--button-bg);
	}

	.om-invite-input::placeholder {
		color: var(--surface-muted);
	}

	.om-role-trigger {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: 0.8125rem;
		font-weight: 500;
		cursor: pointer;
		transition: border-color 120ms;
		white-space: nowrap;
	}

	.om-role-trigger:hover {
		border-color: color-mix(in srgb, var(--center-channel-color) 30%, transparent);
	}

	.om-option-label {
		flex: 1;
		text-align: left;
	}

	:global(.om-check-icon) {
		color: var(--button-bg);
	}

	.om-member-list {
		display: flex;
		flex-direction: column;
	}

	.om-member {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.875rem 0;
	}

	.om-member + .om-member {
		border-top: 1px solid color-mix(in srgb, var(--surface-border) 40%, transparent);
	}

	.om-member-left {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex: 1;
		min-width: 0;
	}

	.om-avatar {
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.om-avatar-fallback {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--button-bg) 10%, transparent);
		color: var(--button-bg);
		font-size: 0.75rem;
		font-weight: 650;
	}

	.om-avatar-pending {
		background-color: color-mix(in srgb, var(--away-indicator) 12%, transparent);
		color: var(--away-indicator);
	}

	.om-member-info {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.0625rem;
	}

	.om-member-name {
		font-size: 0.875rem;
		font-weight: 550;
		color: var(--center-channel-color);
		margin: 0;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.om-guest-wrap {
		display: inline-flex;
	}

	.om-member-email {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.om-member-right {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	@media (max-width: 640px) {
		.om-invite-bar {
			flex-direction: column;
			align-items: stretch;
		}

		.om-member {
			flex-direction: column;
			align-items: flex-start;
			gap: 0.5rem;
		}

		.om-member-right {
			padding-left: 2.75rem;
		}
	}
</style>
