<script lang="ts">
	import { Check, Crown, Eye, Pencil, ShieldCheck, Trash2, UserPlus, X } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import type { ProjectMember, OrgMember, PendingInvitation } from './types';
	import { ROLE_OPTIONS } from './types';
	import { user } from '$lib/stores';
	import { presence } from '$lib/utils/transitions';
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
		Table,
		type DropdownOption
	} from '$lib/components/ui';
	import RadioGroup from '$lib/components/ui/RadioGroup.svelte';
	import type { TableColumn, TableSort } from '$lib/components/ui/Table.svelte';

	type Role = 'admin' | 'member' | 'viewer';
	type Access = 'view' | 'deploy' | 'members' | 'delete';
	type Pick = {
		email: string;
		name: string | null;
		user: OrgMember['user'] | null;
		guest: boolean;
	};
	type Entry =
		| { id: string; kind: 'member'; name: string; email: string; role: string; m: ProjectMember }
		| {
				id: string;
				kind: 'invite';
				name: string;
				email: string;
				role: string;
				inv: PendingInvitation;
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
	const GRANTS: Record<Role, Access[]> = {
		admin: ['view', 'deploy', 'members', 'delete'],
		member: ['view', 'deploy'],
		viewer: ['view']
	};
	const ACCESS: { id: Access; label: string }[] = [
		{ id: 'view', label: 'View' },
		{ id: 'deploy', label: 'Deploy' },
		{ id: 'members', label: 'Members' },
		{ id: 'delete', label: 'Delete' }
	];

	const roleOptions: DropdownOption[] = ROLE_OPTIONS.map((o) => ({
		value: o.value,
		label: o.label,
		icon: ROLE_ICONS[o.value]
	}));

	const canRemove = $derived(canManageMembers && canEdit);
	const canTransfer = $derived(canTransferOwnership && !transferPending && !!onTransferOwnership);

	let filter = $state('');
	let sort = $state<TableSort | null>(null);
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

	const columns = $derived<TableColumn<Entry>[]>([
		{ id: 'member', label: 'Member', sortable: true, sortValue: (e) => e.name.toLowerCase() },
		{
			id: 'role',
			label: 'Role',
			width: '9.5rem',
			sortable: true,
			sortValue: (e) => ['admin', 'member', 'viewer'].indexOf(e.role)
		},
		...ACCESS.map((a) => ({ id: a.id, label: a.label, width: '5rem' })),
		{ id: 'actions', width: canManageMembers ? '5rem' : '0', align: 'end' as const }
	]);

	const entries = $derived<Entry[]>([
		...[...projectMembers]
			.sort(
				(a, b) =>
					Number(b.user.id === ownerId) - Number(a.user.id === ownerId) ||
					displayName(a).localeCompare(displayName(b))
			)
			.map((m) => ({
				id: m.id,
				kind: 'member' as const,
				name: displayName(m),
				email: m.user.email,
				role: shownRole(m),
				m
			})),
		...(canManageMembers ? pendingInvitations : []).map((inv) => ({
			id: inv.id,
			kind: 'invite' as const,
			name: inv.email,
			email: inv.email,
			role: inv.projectRole?.name ?? 'member',
			inv
		}))
	]);

	const query = $derived(filter.trim().toLowerCase());
	const shown = $derived(
		query
			? entries.filter((e) => e.name.toLowerCase().includes(query) || e.email.includes(query))
			: entries
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

	function grants(r: string, access: Access) {
		return (GRANTS[r as Role] ?? GRANTS.viewer).includes(access);
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

<Stack gap="md">
	{#if entries.length > 6 || canManageMembers}
		<div class="bar">
			{#if entries.length > 6}
				<div class="filter">
					<SearchField placeholder="Filter members" size="sm" bind:value={filter} />
				</div>
			{/if}
			{#if canManageMembers}
				<Button variant="primary" size="sm" icon={UserPlus} onclick={openInvite}>Add people</Button>
			{/if}
		</div>
	{/if}

	{#if entries.length > 0}
		<Table
			{columns}
			rows={shown}
			bind:sort
			label="Members"
			rowKey={(e) => e.id}
			emptyText="Nobody matches “{filter}”"
		>
			{#snippet cell(e, col)}
				{#if col.id === 'member'}
					<span class="who">
						{#if e.kind === 'member'}
							<Avatar
								user={e.m.user}
								mood={e.m.user.id === $user?.id ? 'wink' : 'idle'}
								size={28}
							/>
						{:else}
							<Avatar seed={e.email} mood="sleepy" size={28} />
						{/if}
						<span class="who-text">
							<span class="who-name">
								<span class="clip">{e.name}</span>
								{#if e.kind === 'member' && e.m.user.id === ownerId}<Badge>Owner</Badge>{/if}
								{#if e.kind === 'member' && e.m.orgRole === 'guest'}<Badge>Guest</Badge>{/if}
								{#if e.kind === 'invite'}<Badge>Invited</Badge>{/if}
							</span>
							<span class="who-sub clip">
								{e.kind === 'invite' ? `Expires ${expiry(e.inv.expiresAt)}` : e.email}
							</span>
						</span>
					</span>
				{:else if col.id === 'role'}
					{#if e.kind === 'member' && canManageMembers}
						<Dropdown
							bind:value={() => e.role, (v) => changeRole(e.m, v)}
							options={roleOptions}
							size="sm"
							placement="bottom-start"
							ariaLabel="Role for {e.name}"
							loading={updatingMemberId === e.id}
							disabled={updatingMemberId === e.id}
						/>
					{:else}
						<span class="role">{roleLabel(e.role)}</span>
					{/if}
				{:else if col.id === 'actions'}
					<span class="acts">
						{#if e.kind === 'member'}
							{#if e.m.user.id === ownerId && canTransfer}
								<Button
									variant="ghost"
									size="sm"
									icon={Crown}
									label="Transfer ownership"
									onclick={onTransferOwnership}
								/>
							{/if}
							{#if canRemove && e.m.user.id !== ownerId}
								<Button
									variant="ghost"
									size="sm"
									icon={Trash2}
									label="Remove {e.name}"
									loading={removingMemberId === e.id}
									onclick={() => {
										memberToRemove = e.m;
										showRemoveModal = true;
									}}
								/>
							{/if}
						{:else}
							<Button
								variant="ghost"
								size="sm"
								icon={X}
								label="Revoke the invitation for {e.email}"
								loading={revokingInviteId === e.id}
								onclick={() => {
									inviteToRevoke = e.inv;
									showRevokeModal = true;
								}}
							/>
						{/if}
					</span>
				{:else}
					{@const on = grants(e.role, col.id as Access)}
					<span class="grant" class:grant--on={on}>
						{#if on}
							<Check size={15} strokeWidth={2.5} aria-label="Yes" />
						{:else}
							<span class="none" aria-label="No"></span>
						{/if}
					</span>
				{/if}
			{/snippet}
		</Table>
	{:else}
		<EmptyState title="No members yet" />
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
						<ul class="picks">
							{#each picks as p (p.email)}
								<li class="pick" in:presence out:presence>
									<Avatar user={p.user ?? undefined} seed={p.email} size={28} />
									<span class="who-text">
										<span class="who-name">
											<span class="clip">{p.name ?? p.email}</span>
											{#if p.guest}<Badge>Guest</Badge>{/if}
										</span>
										{#if p.name}<span class="who-sub clip">{p.email}</span>{/if}
									</span>
									<Button
										variant="ghost"
										size="sm"
										icon={X}
										label="Remove {p.name ?? p.email}"
										onclick={() => unpick(p.email)}
									/>
								</li>
							{/each}
						</ul>
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
						icon: ROLE_ICONS[o.value]
					}))}
				>
					{#snippet extra(opt)}
						<span class="checklist">
							{#each ACCESS as a (a.id)}
								{@const on = grants(opt.value, a.id)}
								<span class="check" class:check--on={on}>
									{#if on}<Check size={13} strokeWidth={2.5} />{:else}<X size={13} />{/if}
									{a.label}
								</span>
							{/each}
						</span>
					{/snippet}
				</RadioGroup>
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
	.who {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
	}
	.who-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.who-name {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
		color: var(--text-default);
		font-weight: var(--weight-medium);
	}
	.who-sub {
		color: var(--text-muted);
		font-size: var(--text-callout);
	}
	.clip {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.role {
		color: var(--text-muted);
	}
	.grant {
		display: flex;
		align-items: center;
		color: var(--text-faint);
	}
	.grant--on {
		color: var(--status-success);
	}
	.none {
		width: 0.625rem;
		height: 1.5px;
		border-radius: 1px;
		background: currentColor;
	}
	.acts {
		display: flex;
		justify-content: flex-end;
		gap: 0.125rem;
	}
	.picks {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		max-height: 18rem;
		overflow-y: auto;
	}
	.pick {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.375rem 0.25rem 0.375rem 0.5rem;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-sunken);
	}
	.checklist {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		margin-top: 0.25rem;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		color: var(--text-faint);
		font-size: var(--text-caption);
	}
	.check--on {
		color: var(--text-default);
	}
	.check--on :global(svg) {
		color: var(--status-success);
	}
</style>
