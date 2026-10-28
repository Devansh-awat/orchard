<script lang="ts">
	import { Users, Loader2, Trash2, ChevronsUpDown, Mail, UserPlus, Crown } from 'lucide-svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import type { ProjectMember, OrgMember, PendingInvitation } from './types';
	import { ROLE_OPTIONS } from './types';
	import { user } from '$lib/stores';
	import {
		Avatar,
		Badge,
		Combobox,
		Dropdown,
		SelectTrigger,
		type DropdownOption
	} from '$lib/components/ui';

	type Role = 'admin' | 'member' | 'viewer';

	let {
		projectMembers,
		pendingInvitations = [],
		canManageMembers = false,
		canEdit = false,
		ownerId = null,
		memberSearch = $bindable(''),
		newMemberRole = $bindable<Role>('member'),
		filteredOrgMembers,
		addingMember = false,
		removingMemberId = null as string | null,
		updatingMemberId = null as string | null,
		revokingInviteId = null as string | null,
		openRoleMenuId = $bindable<string | null>(null),
		onAddMember,
		onUpdateMemberRole,
		onRemoveMember,
		onRevokeInvitation,
		onEnsureOrgMembersLoaded
	}: {
		projectMembers: ProjectMember[];
		pendingInvitations?: PendingInvitation[];
		canManageMembers?: boolean;
		canEdit?: boolean;
		ownerId?: string | null;
		memberSearch?: string;
		newMemberRole?: Role;
		filteredOrgMembers: OrgMember[];
		addingMember?: boolean;
		removingMemberId?: string | null;
		updatingMemberId?: string | null;
		revokingInviteId?: string | null;
		openRoleMenuId?: string | null;
		onAddMember: (email: string) => void;
		onUpdateMemberRole: (memberId: string, role: string, prevRole: string) => void;
		onRemoveMember: (memberId: string) => void;
		onRevokeInvitation?: (invitationId: string) => void;
		onEnsureOrgMembersLoaded: () => void;
	} = $props();

	const roleOptions: DropdownOption[] = ROLE_OPTIONS.map((o) => ({
		value: o.value,
		label: o.label,
		description: o.desc
	}));

	const searchEmail = $derived(memberSearch.trim().toLowerCase());
	const searchIsEmail = $derived(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(searchEmail));
	const searchIsKnown = $derived(
		projectMembers.some((m) => m.user.email?.toLowerCase() === searchEmail) ||
			pendingInvitations.some((inv) => inv.email.toLowerCase() === searchEmail)
	);
	const showInviteOption = $derived(
		searchIsEmail &&
			!searchIsKnown &&
			!filteredOrgMembers.some((m) => m.user.email.toLowerCase() === searchEmail)
	);

	const orgMembersByEmail = $derived(new Map(filteredOrgMembers.map((om) => [om.user.email, om])));
	const memberOptions = $derived<DropdownOption[]>(
		filteredOrgMembers.map((om) => {
			const name = [om.user.firstName, om.user.lastName].filter(Boolean).join(' ');
			return {
				value: om.user.email,
				label: name || om.user.email,
				description: name ? om.user.email : undefined
			};
		})
	);

	let picked = $state('');

	let memberToRemove = $state<ProjectMember | null>(null);
	let showRemoveModal = $state(false);
	let inviteToRevoke = $state<PendingInvitation | null>(null);
	let showRevokeModal = $state(false);

	function memberDisplayName(m: ProjectMember) {
		const name = [m.user.firstName, m.user.lastName].filter(Boolean).join(' ');
		return name || m.user.email;
	}

	function add(email: string) {
		picked = '';
		if (!email) return;
		onAddMember(email);
	}
</script>

<div class="pj-members-section">
	<div class="pj-members-card pj-glass">
		<div class="pj-members-head">
			<div class="pj-members-title">
				<Users size={16} />
				<span>Members</span>
				<span class="pj-members-count">{projectMembers.length}</span>
			</div>
			{#if canManageMembers}
				<div class="pj-add-member-controls">
					<Dropdown
						bind:value={() => newMemberRole, (v) => (newMemberRole = v as Role)}
						options={roleOptions}
						placement="bottom-end"
						ariaLabel="Role for new project member"
					>
						{#snippet icon(value)}
							<span class="pj-role-dot pj-role-dot--{value}" aria-hidden="true"></span>
						{/snippet}
						{#snippet trigger(attrs, open, selected)}
							<SelectTrigger {...attrs} {open} value={selected?.label} />
						{/snippet}
					</Dropdown>
				</div>
				<div class="pj-picker" onfocusin={onEnsureOrgMembersLoaded}>
					<Combobox
						bind:value={picked}
						bind:query={memberSearch}
						options={memberOptions}
						icon={UserPlus}
						placeholder="Add a member"
						label="Add a member"
						loading={addingMember}
						disabled={addingMember}
						creatable={showInviteOption}
						createLabel={() => `Invite ${searchEmail}`}
						onchange={add}
						oncreate={() => add(searchEmail)}
					>
						{#snippet leading(option)}
							<Avatar
								user={orgMembersByEmail.get(option.value)?.user}
								seed={option.value}
								size={20}
							/>
						{/snippet}
						{#snippet trailing(option)}
							{#if orgMembersByEmail.get(option.value)?.role === 'guest'}
								<Badge>Guest</Badge>
							{/if}
						{/snippet}
						{#snippet empty()}
							{searchIsKnown
								? 'Already a member or invited'
								: 'Type a full email to invite a guest'}
						{/snippet}
					</Combobox>
				</div>
			{/if}
		</div>

		{#if projectMembers.length > 0}
			<ul class="pj-members-list">
				{#each projectMembers as m, i (m.id)}
					<li
						class="pj-member"
						{@attach motionStagger({
							index: i,
							axis: 'x',
							from: { y: -10 }
						})}
					>
						<Avatar
							user={m.user}
							alive
							mood={m.user.id === $user?.id ? 'wink' : 'idle'}
							class="pj-member-avatar"
						/>
						<div class="pj-member-info">
							<span class="pj-member-name">
								{#if m.user.firstName}{m.user.firstName}{#if m.user.lastName}&nbsp;{m.user
											.lastName}{/if}{:else}{m.user.email}{/if}
								{#if m.user.id === ownerId}
									<span
										class="owner-pill"
										title="Everything running in this project is billed against the owner's resource allowance"
									>
										<Crown size={9} />
										Owner
									</span>
								{/if}
								{#if m.orgRole === 'guest'}
									<span
										class="guest-pill"
										title="Guests are only members of specific projects, not the whole organization"
										>Guest</span
									>
								{/if}
							</span>
							<span class="pj-member-email">{m.user.email}</span>
						</div>
						{#if canManageMembers}
							<Dropdown
								bind:value={() => m.role.name, (v) => onUpdateMemberRole(m.id, v, m.role.name)}
								options={roleOptions}
								placement="bottom-end"
								ariaLabel="Role for {m.user.firstName ?? m.user.email}"
								disabled={updatingMemberId === m.id}
							>
								{#snippet icon(value)}
									<span class="pj-role-dot pj-role-dot--{value}" aria-hidden="true"></span>
								{/snippet}
								{#snippet trigger(attrs, open)}
									<button
										type="button"
										class="pj-role-chip pj-role-chip--{m.role.name} pj-role-trigger"
										aria-label="Change role for {m.user.firstName ?? m.user.email}"
										disabled={updatingMemberId === m.id}
										{...attrs}
										data-open={open || undefined}
									>
										{#if updatingMemberId === m.id}
											<Loader2 class="h-3 w-3 animate-spin" />
										{:else}
											<span>{m.role.name}</span>
											<ChevronsUpDown size={12} class="pj-role-caret" />
										{/if}
									</button>
								{/snippet}
							</Dropdown>
						{:else}
							<span class="pj-role-chip pj-role-chip--{m.role.name}">{m.role.name}</span>
						{/if}
						{#if canEdit}
							<button
								class="pj-member-remove"
								title="Remove member"
								aria-label="Remove {m.user.firstName ?? m.user.email}"
								onclick={() => {
									memberToRemove = m;
									showRemoveModal = true;
								}}
								disabled={removingMemberId === m.id}
							>
								{#if removingMemberId === m.id}
									<Loader2 class="h-3.5 w-3.5 animate-spin" />
								{:else}
									<Trash2 class="h-3.5 w-3.5" />
								{/if}
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<div class="pj-members-empty">
				No members yet. Add someone from your organization above, or type an email to invite a
				guest.
			</div>
		{/if}

		{#if canManageMembers && pendingInvitations.length > 0}
			<div class="pj-invites-head">
				<Mail size={13} />
				<span>Pending invitations</span>
				<span class="pj-members-count">{pendingInvitations.length}</span>
			</div>
			<ul class="pj-members-list">
				{#each pendingInvitations as inv, i (inv.id)}
					<li
						class="pj-member pj-member--pending"
						{@attach motionStagger({
							index: i,
							axis: 'x',
							from: { y: -10 }
						})}
					>
						<Avatar seed={inv.email} mood="sleepy" class="pj-member-avatar" />
						<div class="pj-member-info">
							<span class="pj-member-name">
								{inv.email}
								<span
									class="guest-pill"
									title="They'll join as a guest once they accept the email invitation"
									>Invited</span
								>
							</span>
							<span class="pj-member-email"
								>Expires {new Date(inv.expiresAt).toLocaleDateString()}</span
							>
						</div>
						<span class="pj-role-chip pj-role-chip--{inv.projectRole?.name ?? 'member'}"
							>{inv.projectRole?.name ?? 'member'}</span
						>
						<button
							class="pj-member-remove"
							title="Revoke invitation"
							aria-label="Revoke invitation for {inv.email}"
							onclick={() => {
								inviteToRevoke = inv;
								showRevokeModal = true;
							}}
							disabled={revokingInviteId === inv.id}
						>
							{#if revokingInviteId === inv.id}
								<Loader2 class="h-3.5 w-3.5 animate-spin" />
							{:else}
								<Trash2 class="h-3.5 w-3.5" />
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>

<ConfirmModal
	bind:open={showRemoveModal}
	title="Remove member"
	description={memberToRemove
		? `Remove ${memberDisplayName(memberToRemove)} from this project?`
		: ''}
	confirmLabel="Remove"
	onconfirm={() => {
		if (memberToRemove) onRemoveMember(memberToRemove.id);
	}}
	oncancel={() => {}}
/>

<ConfirmModal
	bind:open={showRevokeModal}
	title="Revoke invitation"
	description={inviteToRevoke
		? `Revoke the invitation for ${inviteToRevoke.email}? They won't be able to join with it anymore.`
		: ''}
	confirmLabel="Revoke"
	onconfirm={() => {
		if (inviteToRevoke) onRevokeInvitation?.(inviteToRevoke.id);
	}}
	oncancel={() => {}}
/>
