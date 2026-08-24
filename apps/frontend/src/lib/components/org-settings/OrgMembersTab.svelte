<script lang="ts">
	import { Loader2, UserPlus, Trash2, ChevronDown, Check, Mail, X, Search } from 'lucide-svelte';
	import { UsersRound, MailCheck } from '@jis3r/icons';
	import { motionStagger, springHover } from '$lib/utils/motion.svelte';
	import { Button, Badge, Menu, MenuItem, PopoverPanel } from '$lib/components/ui';
	import SettingsSection from '$lib/components/user-settings/SettingsSection.svelte';
	import { avatarUrl, avatarFilter } from '$lib/avatar';

	interface MemberProject {
		projectMemberId: string;
		id: string;
		name: string;
		slug: string;
		role: string;
	}

	interface Member {
		id: string;
		role: 'owner' | 'admin' | 'member' | 'guest';
		projects?: MemberProject[];
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
		organizationSlug = '',
		revokingAccessId = null,
		onRevokeProjectAccess = undefined,
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
		organizationSlug?: string;
		revokingAccessId?: string | null;
		onRevokeProjectAccess?: (projectId: string, projectMemberId: string) => void;
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

	function memberName(m: Member) {
		return `${m.user.firstName ?? ''} ${m.user.lastName ?? ''}`.trim() || m.user.username || '';
	}

	const ROLE_ORDER: Record<string, number> = { owner: 0, admin: 1, member: 2, guest: 3 };

	let search = $state('');
	let roleFilter = $state<'all' | 'owner' | 'admin' | 'member' | 'guest'>('all');
	let sortKey = $state<'name' | 'role'>('role');
	let expanded = $state<Set<string>>(new Set());

	function toggleExpanded(id: string) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}
	let sortAsc = $state(true);

	const roleCounts = $derived.by(() => {
		const c: Record<string, number> = { all: members.length };
		for (const m of members) c[m.role] = (c[m.role] ?? 0) + 1;
		return c;
	});

	const visibleMembers = $derived.by(() => {
		const q = search.trim().toLowerCase();
		let out = members.filter((m) => {
			if (roleFilter !== 'all' && m.role !== roleFilter) return false;
			if (!q) return true;
			return (
				memberName(m).toLowerCase().includes(q) ||
				m.user.email.toLowerCase().includes(q) ||
				(m.user.username ?? '').toLowerCase().includes(q)
			);
		});
		out = [...out].sort((a, b) => {
			const d =
				sortKey === 'name'
					? memberName(a).localeCompare(memberName(b))
					: ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || memberName(a).localeCompare(memberName(b));
			return sortAsc ? d : -d;
		});
		return out;
	});

	function toggleSort(key: 'name' | 'role') {
		if (sortKey === key) sortAsc = !sortAsc;
		else {
			sortKey = key;
			sortAsc = true;
		}
	}

	const ROLE_TABS: Array<{ id: 'all' | 'owner' | 'admin' | 'member' | 'guest'; label: string }> = [
		{ id: 'all', label: 'All' },
		{ id: 'owner', label: 'Owners' },
		{ id: 'admin', label: 'Admins' },
		{ id: 'member', label: 'Members' },
		{ id: 'guest', label: 'Guests' }
	];
</script>

<SettingsSection title="Members" description="Manage team access" {index}>
	{#snippet icon(hovered)}<UsersRound size={18} animate={hovered} />{/snippet}
	{#snippet badge()}<span class="om-count">{members.length}</span>{/snippet}

	<div class="om-toolbar">
		<div class="om-search">
			<Search size={14} />
			<input
				type="search"
				placeholder="Search name or email…"
				bind:value={search}
				aria-label="Search members"
			/>
		</div>
		<div class="om-filters" role="tablist" aria-label="Filter by role">
			{#each ROLE_TABS as tab (tab.id)}
				<button
					type="button"
					role="tab"
					aria-selected={roleFilter === tab.id}
					class="om-filter"
					class:om-filter--active={roleFilter === tab.id}
					onclick={() => (roleFilter = tab.id)}
				>
					{tab.label}
					<span class="om-filter-count">{roleCounts[tab.id] ?? 0}</span>
				</button>
			{/each}
		</div>
		{#if canInvite}
			<PopoverPanel placement="bottom-end">
				{#snippet trigger(attrs, open)}
					<button
						type="button"
						class="om-invite-trigger"
						aria-haspopup="dialog"
						aria-expanded={open}
						{...attrs}
					>
						<UserPlus size={14} />
						Invite
					</button>
				{/snippet}
				{#snippet children({ close })}
					<div class="om-invite-pop">
						<label class="om-invite-label" for="om-invite-email">Invite by email</label>
						<input
							id="om-invite-email"
							type="email"
							class="om-invite-input"
							placeholder="name@company.com"
							bind:value={newMemberEmail}
						/>
						<div class="om-invite-row">
							<Menu placement="bottom-start">
								{#snippet trigger(attrs, _open)}
									<button type="button" class="om-role-trigger" {...attrs}>
										<span
											>{roleOptions.find((r) => r.value === newMemberRole)?.label || 'Role'}</span
										>
										<ChevronDown class="h-3.5 w-3.5" />
									</button>
								{/snippet}
								{#each roleOptions as option (option.value)}
									<MenuItem onclick={() => (newMemberRole = option.value)}>
										<span class="om-option-label">{option.label}</span>
										{#if newMemberRole === option.value}<Check
												class="h-3.5 w-3.5 om-check-icon"
											/>{/if}
									</MenuItem>
								{/each}
							</Menu>
							<Button
								variant="primary"
								size="sm"
								onclick={() => {
									onAddMember();
									close();
								}}
								loading={addingMember}
								disabled={!newMemberEmail}
							>
								Send invite
							</Button>
						</div>
					</div>
				{/snippet}
			</PopoverPanel>
		{/if}
	</div>

	<div class="om-table">
		<div class="om-thead">
			<button type="button" class="om-th om-th--sort" onclick={() => toggleSort('name')}>
				Member
				{#if sortKey === 'name'}<ChevronDown size={12} class={sortAsc ? '' : 'om-flip'} />{/if}
			</button>
			<span class="om-th">Access</span>
			<button type="button" class="om-th om-th--sort" onclick={() => toggleSort('role')}>
				Role
				{#if sortKey === 'role'}<ChevronDown size={12} class={sortAsc ? '' : 'om-flip'} />{/if}
			</button>
			<span class="om-th om-th--end">Actions</span>
		</div>

		<div class="om-tbody">
			{#each visibleMembers as member (member.user.id)}
				<div class="om-tr">
					<div class="om-td om-td--member">
						<img
							src={avatarUrl(member.user)}
							style="filter: {avatarFilter(member.user)}"
							alt=""
							class="om-avatar"
						/>
						<div class="om-member-info">
							<p class="om-member-name">{memberName(member) || member.user.email}</p>
							<p class="om-member-email">{member.user.email}</p>
						</div>
					</div>
					<div class="om-td">
						{#if member.role === 'owner' || member.role === 'admin'}
							<span
								class="om-access-all"
								title="Owners and admins can access every project in the organization"
							>
								All projects
							</span>
						{:else if (member.projects ?? []).length > 0}
							<button
								type="button"
								class="om-access"
								aria-expanded={expanded.has(member.id)}
								onclick={() => toggleExpanded(member.id)}
							>
								<span class="om-access-count">{(member.projects ?? []).length}</span>
								{(member.projects ?? []).length === 1 ? 'project' : 'projects'}
								<ChevronDown size={12} class={expanded.has(member.id) ? 'om-flip' : ''} />
							</button>
						{:else}
							<span class="om-access-none">No projects</span>
						{/if}
					</div>
					<div class="om-td">
						{#if isOwner && member.role !== 'guest'}
							<Menu placement="bottom-start">
								{#snippet trigger(attrs, _open)}
									<button type="button" class="om-role-trigger" {...attrs}>
										<span>{formatRole(member.role)}</span>
										<ChevronDown class="h-3.5 w-3.5" />
									</button>
								{/snippet}
								{#each roleOptions as option (option.value)}
									<MenuItem onclick={() => onUpdateMemberRole(member.id, option.value)}>
										<span class="om-option-label">{option.label}</span>
										{#if member.role === option.value}<Check
												class="h-3.5 w-3.5 om-check-icon"
											/>{/if}
									</MenuItem>
								{/each}
							</Menu>
						{:else if member.role === 'guest'}
							<span
								class="om-guest-wrap"
								title="Guests only have access to specific projects, not the whole organization"
							>
								<Badge tone="warning">Guest</Badge>
							</span>
						{:else}
							<Badge tone="neutral">{formatRole(member.role)}</Badge>
						{/if}
					</div>
					<div class="om-td om-td--end">
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
				{#if expanded.has(member.id) && member.role !== 'owner' && member.role !== 'admin'}
					<div class="om-access-panel">
						{#each member.projects ?? [] as proj (proj.projectMemberId)}
							<div class="om-access-row">
								<a class="om-access-name" href={`/${organizationSlug}/projects/${proj.slug}`}>
									{proj.name}
								</a>
								<Badge tone="neutral">{formatRole(proj.role)}</Badge>
								{#if canInvite}
									<button
										type="button"
										class="om-revoke"
										disabled={revokingAccessId === proj.projectMemberId}
										onclick={() => onRevokeProjectAccess?.(proj.id, proj.projectMemberId)}
									>
										Revoke
									</button>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			{/each}

			{#if visibleMembers.length === 0}
				<p class="om-noresults">
					No members match {search ? `“${search}”` : 'this filter'}.
				</p>
			{/if}
		</div>
	</div>
</SettingsSection>

{#if canInvite && invitations.length > 0}
	<SettingsSection
		title="Pending invitations"
		description="Invitations awaiting acceptance"
		index={index + 1}
	>
		{#snippet icon(hovered)}<MailCheck size={18} animate={hovered} />{/snippet}
		{#snippet badge()}<span class="om-count">{invitations.length}</span>{/snippet}

		<div class="om-member-list">
			{#each invitations as invitation, i (invitation.id)}
				<div class="om-member" {@attach motionStagger({ index: i })}>
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
		padding: 0 0.5rem;
		border-radius: var(--radius-2xl);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
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
		border-radius: var(--radius-sm);
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		outline: none;
		transition: border-color var(--dur-fast);
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
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--surface-border);
		background-color: var(--center-channel-bg);
		color: var(--center-channel-color);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		cursor: pointer;
		transition: border-color var(--dur-fast);
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
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
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
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
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
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
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

	/* ── Member table ─────────────────────────────────────────────────── */
	.om-toolbar {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
	}
	.om-search {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 12rem;
		max-width: 20rem;
		height: 2.25rem;
		padding: 0 var(--space-3);
		border-radius: var(--radius-md);
		background: var(--fill-quiet);
		box-shadow: inset 0 0 0 1px var(--rule);
		color: var(--text-muted);
		box-sizing: border-box;
	}
	.om-search input {
		flex: 1;
		min-width: 0;
		border: none;
		background: transparent;
		color: var(--text-default);
		font-size: var(--text-body);
		line-height: var(--lh-body);
		outline: none;
	}
	.om-filters {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		padding: 0.25rem;
		border-radius: var(--radius-md);
		background: var(--fill-quiet);
		box-shadow: inset 0 0 0 1px var(--rule);
	}
	.om-filter {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		height: 1.875rem;
		padding: 0 0.75rem;
		border: none;
		border-radius: calc(var(--radius-md) - 0.1875rem);
		background: none;
		color: var(--text-muted);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
	}
	.om-filter:hover {
		color: var(--text-default);
	}
	.om-filter--active {
		background: var(--bg-raised);
		color: var(--text-default);
		box-shadow:
			0 0 0 1px var(--rule),
			0 1px 2px rgb(0 0 0 / 0.06);
	}
	.om-filter-count {
		font-variant-numeric: tabular-nums;
		color: var(--text-faint);
	}
	.om-filter--active .om-filter-count {
		color: var(--text-muted);
	}

	.om-table {
		border-radius: var(--radius-md);
		box-shadow: inset 0 0 0 1px var(--rule);
		overflow: hidden;
	}
	.om-thead,
	.om-tr {
		display: grid;
		align-items: center;
		grid-template-columns: minmax(0, 1fr) 7.5rem 8.5rem 3rem;
		align-items: center;
		gap: var(--space-3);
		padding: 0 var(--space-3);
	}
	.om-thead {
		position: sticky;
		top: 0;
		z-index: 1;
		height: 2.25rem;
		background: var(--fill-quiet);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		box-shadow: inset 0 -1px 0 var(--rule);
	}
	.om-th {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		border: none;
		background: none;
		padding: 0;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--text-faint);
		text-align: left;
	}
	.om-th--sort {
		cursor: pointer;
	}
	.om-th--sort:hover {
		color: var(--text-muted);
	}
	.om-th--end {
		justify-content: flex-end;
	}
	:global(.om-flip) {
		transform: rotate(180deg);
	}

	.om-tbody {
		max-height: 26rem;
		overflow-y: auto;
	}
	.om-tr {
		height: 3.25rem;
		transition: background-color var(--dur-fast) ease;
	}
	.om-tr + .om-tr {
		box-shadow: inset 0 1px 0 var(--rule);
	}
	.om-tr:hover {
		background-color: var(--fill-quiet);
	}
	.om-td {
		min-width: 0;
	}
	.om-td--member {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
	.om-td--end {
		display: flex;
		justify-content: flex-end;
	}
	.om-noresults {
		margin: 0;
		padding: var(--space-10) var(--space-4);
		text-align: center;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-faint);
	}

	@media (max-width: 48rem) {
		.om-thead {
			display: none;
		}
		.om-tr {
			grid-template-columns: minmax(0, 1fr) auto;
			grid-template-areas: 'member role' 'member actions';
			height: auto;
			padding: var(--space-3);
			row-gap: var(--space-2);
		}
		.om-td--member {
			grid-area: member;
		}
	}

	.om-invite-trigger {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		height: 2.25rem;
		padding: 0 var(--space-3);
		margin-left: auto;
		border: none;
		border-radius: var(--radius-md);
		background: var(--fill-soft);
		color: var(--text-default);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
	}
	.om-invite-trigger:hover {
		background: var(--fill-medium);
	}
	.om-invite-pop {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		width: min(24rem, calc(100vw - 3rem));
		padding: var(--space-1);
	}
	.om-invite-label {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		color: var(--text-muted);
	}
	.om-invite-input {
		width: 100%;
		box-sizing: border-box;
		height: 2.25rem;
		padding: 0 0.75rem;
		border: none;
		border-radius: var(--radius-sm);
		background: var(--fill-quiet);
		box-shadow: inset 0 0 0 1px var(--rule);
		color: var(--text-default);
		font-size: var(--text-body);
		line-height: var(--lh-body);
		outline: none;
	}
	.om-invite-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.om-access {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		max-width: 100%;
		height: 1.625rem;
		padding: 0 0.5rem;
		border: none;
		border-radius: var(--radius-pill);
		background: var(--fill-soft);
		color: var(--text-muted);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
	}
	.om-access:hover {
		background: var(--fill-medium);
		color: var(--text-default);
	}
	.om-access-count {
		font-variant-numeric: tabular-nums;
		color: var(--text-default);
	}
	.om-access-none {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}
	.om-access-panel {
		display: flex;
		flex-direction: column;
		padding: var(--space-2) var(--space-3) var(--space-3) 3.5rem;
		background: var(--fill-quiet);
		box-shadow: inset 0 1px 0 var(--rule);
	}
	.om-access-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		height: 2.25rem;
	}
	.om-access-name {
		flex: 1;
		min-width: 0;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
		text-decoration: none;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.om-access-name:hover {
		text-decoration: underline;
	}
	.om-revoke {
		border: none;
		background: none;
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-xs);
		color: var(--status-error);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		cursor: pointer;
	}
	.om-revoke:hover {
		background: var(--status-error-bg);
	}
	.om-revoke:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.om-access-all {
		display: inline-flex;
		align-items: center;
		height: 1.625rem;
		padding: 0 0.5rem;
		border-radius: var(--radius-pill);
		background: var(--accent-subtle);
		color: var(--accent);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 600;
		white-space: nowrap;
	}
</style>
