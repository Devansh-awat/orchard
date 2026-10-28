<script lang="ts">
	import { Crown, Eye, Pencil, ShieldCheck, Trash2, UserPlus, X } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
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
		Modal,
		SearchField,
		Stack,
		Swap,
		List,
		ListRow,
		SectionTitle,
		type DropdownOption
	} from '$lib/components/ui';
	import RadioGroup from '$lib/components/ui/RadioGroup.svelte';

	type Role = 'admin' | 'member' | 'viewer';
	type Pick = {
		email: string;
		name: string | null;
		user: OrgMember['user'] | null;
		guest: boolean;
	};
	let {
		projectMembers,
		pendingInvitations = [],
		canManageMembers = false,
		canEdit = false,
		canTransferOwnership = false,
		transferPending = false,
		ownerId = null,
		memberSearch = $bindable(''),
		filteredOrgMembers,
		addingMember = false,
		removingMemberId = null as string | null,
		updatingMemberId = null as string | null,
		revokingInviteId = null as string | null,
		onAddMembers,
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
		filteredOrgMembers: OrgMember[];
		addingMember?: boolean;
		removingMemberId?: string | null;
		updatingMemberId?: string | null;
		revokingInviteId?: string | null;
		onAddMembers: (emails: string[], role: Role) => Promise<boolean>;
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
		icon: ROLE_ICONS[o.value]
	}));

	const canRemove = $derived(canManageMembers && canEdit);
	const canTransfer = $derived(canTransferOwnership && !transferPending && !!onTransferOwnership);

	let filter = $state('');
	let requestedRole = $state<Record<string, string>>({});

	let inviting = $state(false);
	let step = $state<'people' | 'role'>('people');
	let picks = $state<Pick[]>([]);
	let picked = $state('');
	let role = $state<Role>('member');

	let memberToRemove = $state<ProjectMember | null>(null);
	let showRemoveModal = $state(false);
	let inviteToRevoke = $state<PendingInvitation | null>(null);
	let showRevokeModal = $state(false);

	const members = $derived(
		[...projectMembers].sort(
			(x, y) =>
				Number(y.user.id === ownerId) - Number(x.user.id === ownerId) ||
				displayName(x).localeCompare(displayName(y))
		)
	);
	const query = $derived(filter.trim().toLowerCase());
	const shown = $derived(
		query
			? members.filter(
					(m) =>
						displayName(m).toLowerCase().includes(query) ||
						m.user.email.toLowerCase().includes(query)
				)
			: members
	);

	const known = $derived(
		new Set([
			...projectMembers.map((m) => m.user.email.toLowerCase()),
			...pendingInvitations.map((i) => i.email.toLowerCase()),
			...picks.map((p) => p.email.toLowerCase())
		])
	);
	const searchEmail = $derived(memberSearch.trim().toLowerCase());
	const searchIsEmail = $derived(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(searchEmail));
	const candidates = $derived(
		filteredOrgMembers.filter((om) => !known.has(om.user.email.toLowerCase()))
	);
	const orgMembersByEmail = $derived(new Map(filteredOrgMembers.map((om) => [om.user.email, om])));
	const candidateOptions = $derived<DropdownOption[]>(
		candidates.map((om) => {
			const name = fullName(om.user);
			return {
				value: om.user.email,
				label: name || om.user.email,
				description: name ? om.user.email : undefined
			};
		})
	);
	const canInviteTyped = $derived(
		searchIsEmail &&
			!known.has(searchEmail) &&
			!candidates.some((om) => om.user.email.toLowerCase() === searchEmail)
	);

	function fullName(u: { firstName?: string | null; lastName?: string | null }) {
		return [u.firstName, u.lastName].filter(Boolean).join(' ');
	}

	function displayName(m: ProjectMember) {
		return fullName(m.user) || m.user.email;
	}

	function shownRole(m: ProjectMember) {
		return (updatingMemberId === m.id && requestedRole[m.id]) || m.role.name;
	}

	function roleLabel(r: string) {
		return ROLE_OPTIONS.find((o) => o.value === r)?.label ?? 'Member';
	}

	function changeRole(m: ProjectMember, next: string) {
		if (next === m.role.name) return;
		requestedRole[m.id] = next;
		onUpdateMemberRole(m.id, next, m.role.name);
	}

	function expiry(date: string) {
		return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function openInvite() {
		picks = [];
		picked = '';
		memberSearch = '';
		role = 'member';
		step = 'people';
		inviting = true;
		onEnsureOrgMembersLoaded();
	}

	function pick(email: string) {
		picked = '';
		memberSearch = '';
		if (!email || known.has(email.toLowerCase())) return;
		const om = orgMembersByEmail.get(email);
		picks = [
			...picks,
			{
				email,
				name: om ? fullName(om.user) || null : null,
				user: om?.user ?? null,
				guest: !om || om.role === 'guest'
			}
		];
	}

	function unpick(email: string) {
		picks = picks.filter((p) => p.email !== email);
	}

	async function submit() {
		const ok = await onAddMembers(
			picks.map((p) => p.email),
			role
		);
		if (ok) inviting = false;
	}
</script>

{#snippet roleText(r: string)}
	{@const RoleIcon = ROLE_ICONS[r as Role] ?? Pencil}
	<span class="role"><RoleIcon size={14} aria-hidden="true" />{roleLabel(r)}</span>
{/snippet}

<Stack gap="lg">
	<Stack gap="sm">
		{#if members.length > 6 || canManageMembers}
			<div class="bar">
				{#if members.length > 6}
					<div class="filter">
						<SearchField placeholder="Filter members" size="sm" bind:value={filter} />
					</div>
				{/if}
				{#if canManageMembers}
					<Button variant="primary" size="sm" icon={UserPlus} onclick={openInvite}
						>Add people</Button
					>
				{/if}
			</div>
		{/if}

		{#if shown.length > 0}
			<List label="Members">
				{#each shown as m (m.id)}
					{@const name = displayName(m)}
					{@const isOwner = m.user.id === ownerId}
					{#snippet controls()}
						<span class="controls">
							<span class="role-slot">
								{#if canManageMembers}
									<Dropdown
										bind:value={() => shownRole(m), (v) => changeRole(m, v)}
										options={roleOptions}
										size="sm"
										placement="bottom-end"
										ariaLabel="Role for {name}"
										loading={updatingMemberId === m.id}
										disabled={updatingMemberId === m.id}
									/>
								{:else}
									{@render roleText(shownRole(m))}
								{/if}
							</span>
							{#if canManageMembers}
								<span class="icon-slot">
									{#if isOwner}
										{#if canTransfer}
											<Button
												variant="ghost"
												size="sm"
												icon={Crown}
												label="Transfer ownership"
												onclick={onTransferOwnership}
											/>
										{/if}
									{:else if canRemove}
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
								</span>
							{/if}
						</span>
					{/snippet}
					<ListRow title={name} subtitle={m.user.email} presence pinned actions={controls}>
						{#snippet leading()}
							<Avatar user={m.user} mood={m.user.id === $user?.id ? 'wink' : 'idle'} size={32} />
						{/snippet}
						{#snippet titleSuffix()}
							{#if isOwner}<Badge>Owner</Badge>{/if}
							{#if m.orgRole === 'guest'}<Badge>Guest</Badge>{/if}
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{:else if members.length > 0}
			<EmptyState title="Nobody matches “{filter}”" />
		{:else}
			<EmptyState title="No members yet" />
		{/if}
	</Stack>

	{#if canManageMembers && pendingInvitations.length > 0}
		<Stack gap="sm">
			<SectionTitle title="Invitations" count={pendingInvitations.length} />
			<List label="Invitations">
				{#each pendingInvitations as inv (inv.id)}
					{#snippet controls()}
						<span class="controls">
							<span class="role-slot">
								{@render roleText(inv.projectRole?.name ?? 'member')}
							</span>
							<span class="icon-slot">
								<Button
									variant="ghost"
									size="sm"
									icon={X}
									label="Revoke the invitation for {inv.email}"
									loading={revokingInviteId === inv.id}
									onclick={() => {
										inviteToRevoke = inv;
										showRevokeModal = true;
									}}
								/>
							</span>
						</span>
					{/snippet}
					<ListRow
						title={inv.email}
						subtitle="Expires {expiry(inv.expiresAt)}"
						presence
						pinned
						actions={controls}
					>
						{#snippet leading()}
							<Avatar seed={inv.email} mood="sleepy" size={32} />
						{/snippet}
					</ListRow>
				{/each}
			</List>
		</Stack>
	{/if}
</Stack>

{#if canManageMembers}
	<Modal bind:open={inviting} title={step === 'people' ? 'Add people' : 'Choose a role'}>
		<Swap key={step}>
			{#if step === 'people'}
				<Stack gap="md">
					<Combobox
						bind:value={() => picked, pick}
						bind:query={memberSearch}
						options={candidateOptions}
						size="lg"
						icon={UserPlus}
						placeholder="Name or email"
						label="Find people to add"
						creatable={canInviteTyped}
						createLabel={() => `Invite ${searchEmail}`}
						oncreate={() => pick(searchEmail)}
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
							{searchIsEmail ? 'Already here or invited' : 'Type a full email to invite a guest'}
						{/snippet}
					</Combobox>
					{#if picks.length > 0}
						<List label="People to add">
							{#each picks as p (p.email)}
								{#snippet unpickAction()}
									<Button
										variant="ghost"
										size="sm"
										icon={X}
										label="Remove {p.name ?? p.email}"
										onclick={() => unpick(p.email)}
									/>
								{/snippet}
								<ListRow
									title={p.name ?? p.email}
									subtitle={p.name ? p.email : undefined}
									presence
									pinned
									actions={unpickAction}
								>
									{#snippet leading()}
										<Avatar user={p.user ?? undefined} seed={p.email} size={28} />
									{/snippet}
									{#snippet titleSuffix()}
										{#if p.guest}<Badge>Guest</Badge>{/if}
									{/snippet}
								</ListRow>
							{/each}
						</List>
					{/if}
				</Stack>
			{:else}
				<RadioGroup
					label="Role"
					variant="cards"
					columns={1}
					bind:value={() => role, (v) => (role = v as Role)}
					options={ROLE_OPTIONS.map((o) => ({
						value: o.value,
						label: o.label,
						description: o.desc,
						icon: ROLE_ICONS[o.value]
					}))}
				></RadioGroup>
			{/if}
		</Swap>
		{#snippet footer()}
			{#if step === 'people'}
				<Button variant="ghost" onclick={() => (inviting = false)}>Cancel</Button>
				<Button variant="primary" disabled={picks.length === 0} onclick={() => (step = 'role')}>
					Next
				</Button>
			{:else}
				<Button variant="ghost" onclick={() => (step = 'people')}>Back</Button>
				<Button variant="primary" loading={addingMember} onclick={submit}>
					Add {picks.length === 1 ? (picks[0].name ?? picks[0].email) : `${picks.length} people`}
				</Button>
			{/if}
		{/snippet}
	</Modal>
{/if}

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
	.bar {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
	}
	.filter {
		flex: 1;
		max-width: 18rem;
		margin-right: auto;
	}
	.role {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0 0.75rem;
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
	.controls {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.role-slot {
		display: flex;
		justify-content: flex-end;
		width: 8.5rem;
	}
	.role-slot > :global(:not([popover])) {
		width: 100%;
	}
	.role-slot :global(.trigger) {
		padding-left: 0.75rem;
	}
	.role-slot > :global([popover]) {
		min-width: var(--melt-invoker-width);
	}
	.role-slot > :global([popover] .ui-dropdown-check) {
		display: none;
	}
	.role-slot > :global([popover] .ui-dropdown-option) {
		gap: 0.5rem;
		padding-left: 0.375rem;
	}
	.icon-slot {
		display: flex;
		justify-content: center;
		width: 2rem;
	}
</style>
