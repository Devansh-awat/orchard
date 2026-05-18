<script lang="ts">
	import { Loader2, UserPlus, Trash2, ChevronDown, Check, Mail, X } from 'lucide-svelte';
	import { scale } from 'svelte/transition';

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
		onAddMember,
		onRemoveMember,
		onUpdateMemberRole,
		onResendInvitation,
		onCancelInvitation,
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
		onAddMember: () => void;
		onRemoveMember: (memberId: string) => void;
		onUpdateMemberRole: (memberId: string, role: 'owner' | 'admin' | 'member' | 'guest') => void;
		onResendInvitation: (id: string) => void;
		onCancelInvitation: (id: string) => void;
	} = $props();

	const roleOptions: Array<{ value: 'member' | 'admin' | 'owner'; label: string }> = [
		{ value: 'member', label: 'Member' },
		{ value: 'admin', label: 'Admin' },
		{ value: 'owner', label: 'Owner' }
	];

	let inviteRoleOpen = $state(false);
	let memberRoleOpen = $state<string | null>(null);

	function formatRole(role: string) {
		return role.charAt(0).toUpperCase() + role.slice(1);
	}
</script>

<h1 class="os-tab-title">Members</h1>

<div class="os-card">
	<div class="os-card-header">
		<h2 class="os-card-title">Members</h2>
		<span class="os-card-count">{members.length}</span>
	</div>

	{#if canInvite}
		<div class="os-invite-bar">
			<input
				type="email"
				bind:value={newMemberEmail}
				placeholder="Email address"
				class="input flex-1"
			/>
			<div class="relative">
				<button
					type="button"
					onclick={() => (inviteRoleOpen = !inviteRoleOpen)}
					class="os-role-trigger"
				>
					<span>{roleOptions.find((r) => r.value === newMemberRole)?.label || 'Role'}</span>
					<ChevronDown class="h-3.5 w-3.5" />
				</button>
				{#if inviteRoleOpen}
					<div class="os-role-dropdown" transition:scale={{ duration: 120, start: 0.96 }}>
						{#each roleOptions as option}
							<button
								type="button"
								onclick={() => { newMemberRole = option.value; inviteRoleOpen = false; }}
								class="os-role-option"
							>
								<span>{option.label}</span>
								{#if newMemberRole === option.value}<Check class="h-3.5 w-3.5 text-primary-600" />{/if}
							</button>
						{/each}
					</div>
				{/if}
			</div>
			<button onclick={onAddMember} disabled={addingMember || !newMemberEmail} class="btn btn-primary">
				{#if addingMember}<Loader2 class="h-4 w-4 animate-spin" />{:else}<UserPlus class="h-4 w-4" />{/if}
				Invite
			</button>
		</div>
	{/if}

	<div class="os-member-list">
		{#each members as member}
			<div class="os-member">
				<div class="os-member-left">
					{#if member.user.imageUrl}
						<img src={member.user.imageUrl} alt={member.user.firstName || member.user.email} class="os-member-avatar" />
					{:else}
						<div class="os-member-avatar-fallback">
							{member.user.firstName?.[0] || member.user.email[0].toUpperCase()}
						</div>
					{/if}
					<div class="os-member-info">
						<p class="os-member-name">
							{member.user.firstName || ''} {member.user.lastName || ''}
							{#if member.role === 'guest'}
								<span class="guest-pill" title="Guests are only members of specific projects, not the whole organization">Guest</span>
							{/if}
						</p>
						<p class="os-member-email">{member.user.email}</p>
					</div>
				</div>
				<div class="os-member-right">
					{#if isOwner}
						<div class="relative">
							<button
								type="button"
								onclick={() => (memberRoleOpen = memberRoleOpen === member.id ? null : member.id)}
								class="os-role-trigger"
							>
								<span>{formatRole(member.role)}</span>
								<ChevronDown class="h-3.5 w-3.5" />
							</button>
							{#if memberRoleOpen === member.id}
								<div class="os-role-dropdown" transition:scale={{ duration: 120, start: 0.96 }}>
									{#each roleOptions as option}
										<button
											type="button"
											onclick={() => { onUpdateMemberRole(member.id, option.value); memberRoleOpen = null; }}
											class="os-role-option"
										>
											<span>{option.label}</span>
											{#if member.role === option.value}<Check class="h-3.5 w-3.5 text-primary-600" />{/if}
										</button>
									{/each}
								</div>
							{/if}
						</div>
					{:else}
						<span class="os-role-badge">{formatRole(member.role)}</span>
					{/if}
					{#if canInvite && member.role !== 'owner'}
						<button onclick={() => onRemoveMember(member.id)} class="os-member-remove" title="Remove member">
							<Trash2 class="h-3.5 w-3.5" />
						</button>
					{/if}
				</div>
			</div>
		{/each}
	</div>
</div>

<!-- Pending Invitations -->
{#if canInvite && invitations.length > 0}
	<div class="os-card">
		<div class="os-card-header">
			<h2 class="os-card-title">Pending Invitations</h2>
			<span class="os-card-count">{invitations.length}</span>
		</div>
		<div class="os-member-list">
			{#each invitations as invitation}
				<div class="os-member">
					<div class="os-member-left">
						<div class="os-member-avatar-fallback os-member-avatar-pending">
							<Mail class="h-3.5 w-3.5" />
						</div>
						<div class="os-member-info">
							<p class="os-member-name">{invitation.email}</p>
							<p class="os-member-email">
								Invited {new Date(invitation.createdAt).toLocaleDateString()} · Expires {new Date(invitation.expiresAt).toLocaleDateString()}
							</p>
						</div>
					</div>
					<div class="os-member-right">
						<span class="os-role-badge">{formatRole(invitation.role)}</span>
						<button
							onclick={() => onResendInvitation(invitation.id)}
							disabled={resendingInvitationId === invitation.id}
							class="os-member-action"
							title="Resend"
						>
							{#if resendingInvitationId === invitation.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Mail class="h-3.5 w-3.5" />{/if}
						</button>
						<button
							onclick={() => onCancelInvitation(invitation.id)}
							disabled={cancellingInvitationId === invitation.id}
							class="os-member-remove"
							title="Cancel"
						>
							{#if cancellingInvitationId === invitation.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<X class="h-3.5 w-3.5" />{/if}
						</button>
					</div>
				</div>
			{/each}
		</div>
	</div>
{/if}
