<script lang="ts">
	import { Crown, Eye, Pencil, ShieldCheck, Trash2, UserPlus } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import type { ProjectMember, OrgMember, PendingInvitation } from './types';
	import { ROLE_OPTIONS } from './types';
	import { user } from '$lib/stores';
	import {
		Avatar,
		Badge,
		Button,
		Combobox,
		Dropdown,
		EmptyState,
		List,
		ListRow,
		SectionTitle,
		Stack,
		type DropdownOption
	} from '$lib/components/ui';

	type Role = 'admin' | 'member' | 'viewer';

	let {
		projectMembers,
		pendingInvitations = [],
		canManageMembers = false,
		canEdit = false,
		canTransferOwnership = false,
		transferPending = false,
		ownerId = null,
		memberSearch = $bindable(''),
		newMemberRole = $bindable<Role>('member'),
		filteredOrgMembers,
		addingMember = false,
		removingMemberId = null as string | null,
		updatingMemberId = null as string | null,
		revokingInviteId = null as string | null,
		openRoleMenuId: _openRoleMenuId = $bindable<string | null>(null),
		onAddMember,
		onUpdateMemberRole,
		onRemoveMember,
		onRevokeInvitation,
		onEnsureOrgMembersLoaded,
		onTransferOwnership = undefined
	}: {
		projectMembers: ProjectMember[];
		pendingInvitations?: PendingInvitation[];
		canManageMembers?: boolean;
		canEdit?: boolean;
		canTransferOwnership?: boolean;
		transferPending?: boolean;
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
		onTransferOwnership?: () => void;
	} = $props();

	const ROLE_ICONS = { admin: ShieldCheck, member: Pencil, viewer: Eye };

	const roleOptions: DropdownOption[] = ROLE_OPTIONS.map((o) => ({
		value: o.value,
		label: o.label,
		description: o.desc,
		icon: ROLE_ICONS[o.value]
	}));

	const canRemove = $derived(canManageMembers && canEdit);
	const canTransfer = $derived(canTransferOwnership && !transferPending && !!onTransferOwnership);

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
	let requestedRole = $state<Record<string, string>>({});

	let memberToRemove = $state<ProjectMember | null>(null);
	let showRemoveModal = $state(false);
	let inviteToRevoke = $state<PendingInvitation | null>(null);
	let showRevokeModal = $state(false);

	function displayName(m: ProjectMember) {
		const name = [m.user.firstName, m.user.lastName].filter(Boolean).join(' ');
		return name || m.user.email;
	}

	function roleLabel(role: string | undefined) {
		return ROLE_OPTIONS.find((o) => o.value === role)?.label ?? 'Member';
	}

	function shownRole(m: ProjectMember) {
		return (updatingMemberId === m.id && requestedRole[m.id]) || m.role.name;
	}

	function changeRole(m: ProjectMember, role: string) {
		if (role === m.role.name) return;
		requestedRole[m.id] = role;
		onUpdateMemberRole(m.id, role, m.role.name);
	}

	function expiry(date: string) {
		return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function add(email: string) {
		picked = '';
		if (!email) return;
		onAddMember(email);
	}
</script>

<Stack gap="lg">
	<Stack gap="sm">
		{#if canManageMembers}
			<div class="add">
				<div class="add-search" onfocusin={onEnsureOrgMembersLoaded}>
					<Combobox
						bind:value={picked}
						bind:query={memberSearch}
						options={memberOptions}
						icon={UserPlus}
						placeholder="Add people by name or email"
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
				<div class="add-role">
					<Dropdown
						bind:value={() => newMemberRole, (v) => (newMemberRole = v as Role)}
						options={roleOptions}
						placement="bottom-end"
						ariaLabel="Role for new members"
					/>
				</div>
			</div>
		{/if}

		{#if projectMembers.length > 0}
			<List label="Members">
				{#each projectMembers as m (m.id)}
					{@const name = displayName(m)}
					{@const isOwner = m.user.id === ownerId}
					{#snippet memberActions()}
						<Dropdown
							bind:value={() => shownRole(m), (v) => changeRole(m, v)}
							options={roleOptions}
							size="sm"
							placement="bottom-end"
							ariaLabel="Role for {name}"
							loading={updatingMemberId === m.id}
							disabled={updatingMemberId === m.id}
						/>
						{#if isOwner && canTransfer}
							<Button variant="ghost" size="sm" icon={Crown} onclick={onTransferOwnership}>
								Transfer
							</Button>
						{/if}
						{#if canRemove}
							<Button
								variant="ghost"
								size="sm"
								icon={Trash2}
								label="Remove {name}"
								loading={removingMemberId === m.id}
								onclick={() => {
									memberToRemove = m;
									showRemoveModal = true;
								}}
							/>
						{/if}
					{/snippet}
					<ListRow title={name} presence actions={canManageMembers ? memberActions : undefined}>
						{#snippet leading()}
							<Avatar user={m.user} mood={m.user.id === $user?.id ? 'wink' : 'idle'} size={32} />
						{/snippet}
						{#snippet titleSuffix()}
							{#if isOwner}<Badge>Owner</Badge>{/if}
							{#if m.orgRole === 'guest'}<Badge>Guest</Badge>{/if}
						{/snippet}
						{#snippet subtitle()}
							<span class="clip">{m.user.email}</span>
							{#if isOwner}
								<span aria-hidden="true">·</span>
								<span class="clip">Pays for this project</span>
							{/if}
						{/snippet}
						{#snippet trailing()}
							{roleLabel(shownRole(m))}
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{:else}
			<EmptyState
				title="No members yet"
				description={canManageMembers
					? 'Add someone from your organization, or type an email to invite a guest.'
					: undefined}
			/>
		{/if}
	</Stack>

	{#if canManageMembers && pendingInvitations.length > 0}
		<Stack gap="sm">
			<SectionTitle title="Pending invitations" count={pendingInvitations.length} />
			<List label="Pending invitations">
				{#each pendingInvitations as inv (inv.id)}
					<ListRow title={inv.email} presence>
						{#snippet leading()}
							<Avatar seed={inv.email} mood="sleepy" size={32} />
						{/snippet}
						{#snippet subtitle()}
							<span>Sent <RelativeTime date={inv.createdAt} /></span>
							<span aria-hidden="true">·</span>
							<span class="clip">Expires {expiry(inv.expiresAt)}</span>
						{/snippet}
						{#snippet trailing()}
							{roleLabel(inv.projectRole?.name)}
						{/snippet}
						{#snippet actions()}
							<Button
								variant="ghost"
								size="sm"
								loading={revokingInviteId === inv.id}
								aria-label="Revoke the invitation for {inv.email}"
								onclick={() => {
									inviteToRevoke = inv;
									showRevokeModal = true;
								}}
							>
								Revoke
							</Button>
						{/snippet}
					</ListRow>
				{/each}
			</List>
		</Stack>
	{/if}
</Stack>

<ConfirmModal
	bind:open={showRemoveModal}
	title="Remove member"
	description={memberToRemove ? `${displayName(memberToRemove)} loses access to this project.` : ''}
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
		? `${inviteToRevoke.email} won't be able to join with this invitation.`
		: ''}
	confirmLabel="Revoke"
	onconfirm={() => {
		if (inviteToRevoke) onRevokeInvitation?.(inviteToRevoke.id);
	}}
	oncancel={() => {}}
/>

<style>
	.add {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.add-search {
		flex: 1;
		min-width: 0;
	}
	.add-role {
		flex-shrink: 0;
		width: 8.5rem;
	}
	.clip {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
