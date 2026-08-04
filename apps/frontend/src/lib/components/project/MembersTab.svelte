<script lang="ts">
	import { Users, Loader2, Trash2, ChevronDown, Check, Mail, UserPlus } from 'lucide-svelte';
	import { motionStagger, motionPopover } from '$lib/utils/motion.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import type { ProjectMember, OrgMember, PendingInvitation } from './types';
	import { ROLE_OPTIONS } from './types';

	let {
		projectMembers,
		pendingInvitations = [],
		canManageMembers = false,
		canEdit = false,
		memberSearch = $bindable(''),
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
		memberSearch?: string;
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

	// A search string that looks like an email but matches no org member can
	// be invited as a guest — the backend emails them an invitation.
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

	let pickerOpen = $state(false);
	let pickerRender = $state(false);
	let renderRoleMenuId = $state<string | null>(null);

	let memberToRemove = $state<ProjectMember | null>(null);
	let showRemoveModal = $state(false);
	let inviteToRevoke = $state<PendingInvitation | null>(null);
	let showRevokeModal = $state(false);

	function memberDisplayName(m: ProjectMember) {
		const name = [m.user.firstName, m.user.lastName].filter(Boolean).join(' ');
		return name || m.user.email;
	}

	$effect(() => {
		if (pickerOpen) pickerRender = true;
	});
	$effect(() => {
		if (openRoleMenuId !== null) renderRoleMenuId = openRoleMenuId;
	});

	// Portal an element to <body> and pin it under a reference element
	function portalUnder(getAnchor: () => Element | null | undefined, offset = 6) {
		return (el: Element) => {
			const node = el as HTMLElement;
			const place = () => {
				const anchor = getAnchor();
				if (!anchor) return;
				const r = anchor.getBoundingClientRect();
				node.style.position = 'fixed';
				node.style.top = `${r.bottom + offset}px`;
				node.style.right = `${window.innerWidth - r.right}px`;
				node.style.left = 'auto';
				node.style.zIndex = '9999';
			};
			place();
			document.body.appendChild(node);
			const onResize = () => place();
			window.addEventListener('resize', onResize);
			window.addEventListener('scroll', onResize, true);
			return () => {
				window.removeEventListener('resize', onResize);
				window.removeEventListener('scroll', onResize, true);
				try {
					node.remove();
				} catch {
					/* already removed */
				}
			};
		};
	}
</script>

<svelte:window
	onclick={() => (openRoleMenuId = null)}
	onkeydown={(e) => {
		if (e.key === 'Escape') openRoleMenuId = null;
	}}
/>

<div class="pj-members-section">
	<div class="pj-members-card pj-glass">
		<div class="pj-members-head">
			<div class="pj-members-title">
				<Users size={16} />
				<span>Members</span>
				<span class="pj-members-count">{projectMembers.length}</span>
			</div>
			{#if canManageMembers}
				<div class="pj-picker">
					<input
						type="text"
						bind:value={memberSearch}
						placeholder="Add a member…"
						class="pj-invite-input"
						onfocus={() => {
							pickerOpen = true;
							onEnsureOrgMembersLoaded();
						}}
						onblur={() => setTimeout(() => (pickerOpen = false), 150)}
					/>
					{#if pickerRender && filteredOrgMembers.length > 0}
						<div
							class="pj-picker-dropdown"
							{@attach motionPopover({
								from: { y: -8, scale: 0.96 },
								closing: () => !pickerOpen,
								onClosed: () => {
									pickerRender = false;
								}
							})}
						>
							{#each filteredOrgMembers as om (om.id)}
								<button
									type="button"
									class="pj-picker-item"
									onmousedown={(e) => e.preventDefault()}
									onclick={() => onAddMember(om.user.email)}
									disabled={addingMember}
								>
									{#if om.user.imageUrl}
										<img src={om.user.imageUrl} alt="" class="pj-member-avatar" />
									{:else}
										<div class="pj-member-avatar pj-member-avatar--letter">
											{(om.user.firstName ?? om.user.email).charAt(0).toUpperCase()}
										</div>
									{/if}
									<div class="pj-member-info">
										<span class="pj-member-name">
											{#if om.user.firstName}{om.user.firstName}{#if om.user.lastName}&nbsp;{om.user
														.lastName}{/if}{:else}{om.user.email}{/if}
											{#if om.role === 'guest'}
												<span
													class="guest-pill"
													title="Guests only see projects they're explicit members of">Guest</span
												>
											{/if}
										</span>
										{#if om.user.firstName}
											<span class="pj-member-email">{om.user.email}</span>
										{/if}
									</div>
								</button>
							{/each}
						</div>
					{:else if pickerRender && memberSearch.trim() && filteredOrgMembers.length === 0}
						<div
							class="pj-picker-dropdown"
							{@attach motionPopover({
								from: { y: -8, scale: 0.96 },
								closing: () => !pickerOpen,
								onClosed: () => {
									pickerRender = false;
								}
							})}
						>
							{#if showInviteOption}
								<button
									type="button"
									class="pj-picker-item pj-picker-invite"
									onmousedown={(e) => e.preventDefault()}
									onclick={() => onAddMember(searchEmail)}
									disabled={addingMember}
								>
									<div class="pj-member-avatar pj-member-avatar--letter">
										{#if addingMember}
											<Loader2 class="h-3.5 w-3.5 animate-spin" />
										{:else}
											<UserPlus size={14} />
										{/if}
									</div>
									<div class="pj-member-info">
										<span class="pj-member-name">Invite {searchEmail}</span>
										<span class="pj-member-email"
											>Not on Orchard yet — they'll get an email and join as a guest</span
										>
									</div>
								</button>
							{:else if searchIsKnown}
								<div class="pj-picker-empty">Already a member or invited</div>
							{:else}
								<div class="pj-picker-empty">
									No matching org members — type a full email to invite a guest
								</div>
							{/if}
						</div>
					{/if}
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
						{#if m.user.imageUrl}
							<img src={m.user.imageUrl} alt="" class="pj-member-avatar" />
						{:else}
							<div class="pj-member-avatar pj-member-avatar--letter">
								{(m.user.firstName ?? m.user.email).charAt(0).toUpperCase()}
							</div>
						{/if}
						<div class="pj-member-info">
							<span class="pj-member-name">
								{#if m.user.firstName}{m.user.firstName}{#if m.user.lastName}&nbsp;{m.user
											.lastName}{/if}{:else}{m.user.email}{/if}
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
							{@const triggerId = `pj-role-trigger-${m.id}`}
							<div class="pj-role-wrap">
								<button
									type="button"
									id={triggerId}
									class="pj-role-chip pj-role-chip--{m.role.name} pj-role-trigger"
									aria-haspopup="listbox"
									aria-expanded={openRoleMenuId === m.id}
									aria-label="Change role for {m.user.firstName ?? m.user.email}"
									disabled={updatingMemberId === m.id}
									onclick={(e) => {
										e.stopPropagation();
										openRoleMenuId = openRoleMenuId === m.id ? null : m.id;
									}}
								>
									{#if updatingMemberId === m.id}
										<Loader2 class="h-3 w-3 animate-spin" />
									{:else}
										<span>{m.role.name}</span>
										<ChevronDown class="h-3 w-3 pj-role-caret" />
									{/if}
								</button>
								{#if renderRoleMenuId === m.id}
									<div
										class="pj-role-menu"
										role="listbox"
										onclick={(e) => e.stopPropagation()}
										{@attach motionPopover({
											from: { y: -6, scale: 0.9 },
											closing: () => openRoleMenuId !== m.id,
											onClosed: () => {
												if (renderRoleMenuId === m.id) renderRoleMenuId = null;
											}
										})}
										{@attach portalUnder(() => document.getElementById(triggerId))}
									>
										{#each ROLE_OPTIONS as opt (opt.value)}
											<button
												type="button"
												role="option"
												class="pj-role-option"
												class:is-selected={m.role.name === opt.value}
												aria-selected={m.role.name === opt.value}
												onclick={() => {
													openRoleMenuId = null;
													onUpdateMemberRole(m.id, opt.value, m.role.name);
												}}
											>
												<span class="pj-role-option-check">
													{#if m.role.name === opt.value}
														<Check class="h-3.5 w-3.5" />
													{/if}
												</span>
												<span class="pj-role-option-text">
													<span class="pj-role-option-label">
														<span class="pj-role-dot pj-role-dot--{opt.value}"></span>
														{opt.label}
													</span>
													<span class="pj-role-option-desc">{opt.desc}</span>
												</span>
											</button>
										{/each}
									</div>
								{/if}
							</div>
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
						<div class="pj-member-avatar pj-member-avatar--letter">
							{inv.email.charAt(0).toUpperCase()}
						</div>
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
