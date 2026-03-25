<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { apiFetch, user, toasts } from '$lib/stores';
	import { ArrowLeft, Loader2, Pencil, Camera, X, UserPlus, Trash2, ChevronDown, Check, Mail, Building2, Users, CreditCard, Shield } from 'lucide-svelte';
	import { fade, scale } from 'svelte/transition';
	import { Avatar as AvatarBuilder } from 'melt/builders';

	interface Member {
		id: string;
		role: 'owner' | 'admin' | 'member';
		user: {
			id: string;
			firstName?: string;
			lastName?: string;
			email: string;
			imageUrl?: string;
			username?: string;
		};
	}

	interface Organization {
		id: string;
		name: string;
		slug: string;
		description?: string;
		avatarUrl?: string;
		workspaces?: unknown[];
		members?: Member[];
	}

	interface Invitation {
		id: string;
		email: string;
		role: 'owner' | 'admin' | 'member';
		createdAt: string;
		expiresAt: string;
		inviter: {
			firstName?: string;
			lastName?: string;
			username?: string;
			email: string;
		};
	}

	let organization = $state<Organization | null>(null);
	let members = $state<Member[]>([]);
	let invitations = $state<Invitation[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let currentUserRole = $state<'owner' | 'admin' | 'member' | null>(null);

	// Edit state
	let isEditing = $state(false);
	let editingName = $state('');
	let editingDescription = $state('');
	let updating = $state(false);

	// Avatar state
	let uploadingAvatar = $state(false);
	let deletingAvatar = $state(false);
	let avatarInput: HTMLInputElement;

	// Member state
	let newMemberEmail = $state('');
	let newMemberRole = $state<'member' | 'admin' | 'owner'>('member');
	let addingMember = $state(false);
	let inviteRoleOpen = $state(false);
	let memberRoleOpen = $state<string | null>(null);

	// Invitation state
	let resendingInvitationId = $state<string | null>(null);
	let cancellingInvitationId = $state<string | null>(null);

	const roleOptions: Array<{ value: 'member' | 'admin' | 'owner'; label: string }> = [
		{ value: 'member', label: 'Member' },
		{ value: 'admin', label: 'Admin' },
		{ value: 'owner', label: 'Owner' }
	];

	const organizationSlug = $derived($page.params.orgSlug);
	const canEditOrg = $derived(currentUserRole === 'owner' || currentUserRole === 'admin');
	const canInvite = $derived(currentUserRole === 'owner' || currentUserRole === 'admin');
	const isOwner = $derived(currentUserRole === 'owner');

	const orgAvatar = new AvatarBuilder({
		src: () => organization?.avatarUrl,
		delayMs: 120
	});

	function formatRole(role: string) {
		return role.charAt(0).toUpperCase() + role.slice(1);
	}

	async function fetchOrganization() {
		loading = true;
		error = null;

		try {
			const response = await apiFetch(`/apiv1/organizations/slug/${organizationSlug}`);
			if (!response.ok) {
				throw new Error('Failed to fetch organization');
			}

			const data = await response.json();
			organization = data;
			members = data.members || [];

			const roleResponse = await apiFetch(`/apiv1/organizations/${data.id}/members/me`);
			if (roleResponse.ok) {
				const roleData = await roleResponse.json();
				currentUserRole = roleData.role;

				if (roleData.role === 'owner' || roleData.role === 'admin') {
					await fetchInvitations();
				}
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to fetch organization';
		} finally {
			loading = false;
		}
	}

	function startEditing() {
		editingName = organization?.name || '';
		editingDescription = organization?.description || '';
		isEditing = true;
	}

	function cancelEditing() {
		isEditing = false;
	}

	async function saveOrganization() {
		if (!organization) return;

		updating = true;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: editingName,
					description: editingDescription
				})
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to update organization');
			}

			toasts.add({ title: 'Organization updated', color: 'success' });
			isEditing = false;
			fetchOrganization();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update',
				color: 'error'
			});
		} finally {
			updating = false;
		}
	}

	async function uploadAvatar(event: Event) {
		if (!organization || !canEditOrg) return;

		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
		if (!allowedTypes.includes(file.type)) {
			toasts.add({ title: 'Invalid file type', description: 'Only JPEG, PNG, GIF, and WebP images are allowed', color: 'error' });
			return;
		}

		if (file.size > 5 * 1024 * 1024) {
			toasts.add({ title: 'File too large', description: 'Maximum file size is 5MB', color: 'error' });
			return;
		}

		uploadingAvatar = true;
		try {
			const formData = new FormData();
			formData.append('file', file);

			const response = await apiFetch(`/apiv1/organizations/${organization.id}/avatar`, {
				method: 'POST',
				body: formData
			});

			if (!response.ok) throw new Error('Failed to upload avatar');

			toasts.add({ title: 'Avatar updated', color: 'success' });
			fetchOrganization();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to upload avatar', color: 'error' });
		} finally {
			uploadingAvatar = false;
			if (avatarInput) avatarInput.value = '';
		}
	}

	async function deleteAvatar() {
		if (!organization || !canEditOrg) return;

		deletingAvatar = true;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/avatar`, { method: 'DELETE' });
			if (!response.ok) throw new Error('Failed to delete avatar');

			toasts.add({ title: 'Avatar removed', color: 'success' });
			fetchOrganization();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to delete avatar', color: 'error' });
		} finally {
			deletingAvatar = false;
		}
	}

	async function addMember() {
		if (!organization || !newMemberEmail) return;

		addingMember = true;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/members`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: newMemberEmail, role: newMemberRole })
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to add member');
			}

			toasts.add({ title: 'Member added', color: 'success' });
			newMemberEmail = '';
			newMemberRole = 'member';
			await fetchOrganization();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to add member', color: 'error' });
		} finally {
			addingMember = false;
		}
	}

	async function removeMember(memberId: string) {
		if (!organization) return;

		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/members/${memberId}`, { method: 'DELETE' });
			if (!response.ok) throw new Error('Failed to remove member');

			toasts.add({ title: 'Member removed', color: 'success' });
			fetchOrganization();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to remove member', color: 'error' });
		}
	}

	async function updateMemberRole(memberId: string, newRole: 'owner' | 'admin' | 'member') {
		if (!organization) return;

		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/members/${memberId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ role: newRole })
			});

			if (!response.ok) throw new Error('Failed to update member role');

			toasts.add({ title: 'Role updated', color: 'success' });
			fetchOrganization();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to update role', color: 'error' });
		}
	}

	async function fetchInvitations() {
		if (!organization) return;

		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/invitations`);
			if (response.ok) {
				invitations = await response.json();
			}
		} catch (e) {
			console.error('Failed to fetch invitations:', e);
		}
	}

	async function resendInvitation(invitationId: string) {
		if (!organization) return;

		resendingInvitationId = invitationId;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/invitations/${invitationId}/resend`, { method: 'POST' });
			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to resend invitation');
			}

			toasts.add({ title: 'Invitation resent', color: 'success' });
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to resend invitation', color: 'error' });
		} finally {
			resendingInvitationId = null;
		}
	}

	async function cancelInvitation(invitationId: string) {
		if (!organization) return;

		cancellingInvitationId = invitationId;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/invitations/${invitationId}`, { method: 'DELETE' });
			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to cancel invitation');
			}

			toasts.add({ title: 'Invitation cancelled', color: 'success' });
			invitations = invitations.filter(inv => inv.id !== invitationId);
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to cancel invitation', color: 'error' });
		} finally {
			cancellingInvitationId = null;
		}
	}

	onMount(() => {
		fetchOrganization();
	});
</script>

{#if error}
	<div class="os-page"><div class="alert alert-error">{error}</div></div>
{/if}

{#if loading}
	<div class="os-page">
		<div class="flex justify-center py-16">
			<Loader2 class="h-6 w-6 animate-spin text-primary-600" />
		</div>
	</div>
{:else if organization}
	<div class="os-page">
		<button onclick={() => window.history.back()} class="os-back">
			<ArrowLeft class="h-4 w-4" />
			Back
		</button>

		<!-- Header -->
		<div class="os-header">
			<div class="os-header-left">
				<div class="os-avatar-wrap">
					<div class="os-avatar">
						<img {...orgAvatar.image} alt={organization.name} class="os-avatar-img" />
						<span {...orgAvatar.fallback} class="os-avatar-fallback">
							{organization.name[0]}
						</span>
					</div>
					{#if canEditOrg}
						<input bind:this={avatarInput} type="file" accept="image/jpeg,image/png,image/gif,image/webp" class="hidden" onchange={uploadAvatar} />
						<button onclick={() => avatarInput?.click()} disabled={uploadingAvatar} class="os-avatar-edit">
							{#if uploadingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Camera class="h-3 w-3" />{/if}
						</button>
						{#if organization.avatarUrl}
							<button onclick={deleteAvatar} disabled={deletingAvatar} class="os-avatar-remove">
								{#if deletingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<X class="h-3 w-3" />{/if}
							</button>
						{/if}
					{/if}
				</div>
				<div>
					<h1 class="os-title">{organization.name}</h1>
					<p class="os-slug">{organization.slug}</p>
				</div>
			</div>
			{#if canEditOrg && !isEditing}
				<button onclick={startEditing} class="btn btn-secondary">
					<Pencil class="h-4 w-4" />
					Edit
				</button>
			{/if}
		</div>

		<!-- Edit form -->
		{#if isEditing}
			<div class="os-card" transition:fade={{ duration: 150 }}>
				<div class="os-card-body">
					<div class="os-edit-grid">
						<div class="os-field">
							<label for="org-name" class="os-field-label">Name</label>
							<input id="org-name" type="text" bind:value={editingName} class="input" />
						</div>
						<div class="os-field">
							<label for="org-desc" class="os-field-label">Description</label>
							<textarea id="org-desc" bind:value={editingDescription} rows="2" class="input"></textarea>
						</div>
					</div>
					<div class="os-edit-actions">
						<button onclick={cancelEditing} class="btn btn-secondary">Cancel</button>
						<button onclick={saveOrganization} disabled={updating} class="btn btn-primary">
							{#if updating}<Loader2 class="h-4 w-4 animate-spin" />{/if}
							Save
						</button>
					</div>
				</div>
			</div>
		{/if}

		<!-- Stats row -->
		<div class="os-stats">
			<div class="os-stat">
				<div class="os-stat-icon"><Building2 class="h-4 w-4" /></div>
				<div>
					<p class="os-stat-value">{organization.workspaces?.length || 0}</p>
					<p class="os-stat-label">Workspaces</p>
				</div>
			</div>
			<div class="os-stat">
				<div class="os-stat-icon"><Users class="h-4 w-4" /></div>
				<div>
					<p class="os-stat-value">{members.length}</p>
					<p class="os-stat-label">Members</p>
				</div>
			</div>
			<div class="os-stat">
				<div class="os-stat-icon"><Shield class="h-4 w-4" /></div>
				<div>
					<p class="os-stat-value">{formatRole(currentUserRole || 'member')}</p>
					<p class="os-stat-label">Your role</p>
				</div>
			</div>
			{#if isOwner}
				<div class="os-stat">
					<div class="os-stat-icon"><CreditCard class="h-4 w-4" /></div>
					<div>
						<p class="os-stat-value">Enterprise</p>
						<p class="os-stat-label">Plan</p>
					</div>
				</div>
			{/if}
		</div>

		<!-- Members -->
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
					<button onclick={addMember} disabled={addingMember || !newMemberEmail} class="btn btn-primary">
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
													onclick={() => { updateMemberRole(member.id, option.value); memberRoleOpen = null; }}
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
								<button onclick={() => removeMember(member.id)} class="os-member-remove" title="Remove member">
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
									onclick={() => resendInvitation(invitation.id)}
									disabled={resendingInvitationId === invitation.id}
									class="os-member-action"
									title="Resend"
								>
									{#if resendingInvitationId === invitation.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Mail class="h-3.5 w-3.5" />{/if}
								</button>
								<button
									onclick={() => cancelInvitation(invitation.id)}
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
	</div>
{/if}

<style>
	.os-page {
		padding: 2.5rem 2.5rem 3rem;
		max-width: 52rem;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.os-back {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		color: var(--surface-muted);
		cursor: pointer;
		transition: color 120ms ease;
		align-self: flex-start;
	}
	.os-back:hover { color: var(--center-channel-color); }

	/* Header */
	.os-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.os-header-left {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.os-avatar-wrap {
		position: relative;
		flex-shrink: 0;
	}

	.os-avatar {
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 0.875rem;
		overflow: hidden;
	}

	.os-avatar-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.os-avatar-fallback {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		font-size: 1.25rem;
		font-weight: 700;
		background-color: color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-bg));
		color: var(--center-channel-color);
	}

	.os-avatar-edit, .os-avatar-remove {
		position: absolute;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		border: 2px solid var(--surface-bg);
		cursor: pointer;
		transition: opacity 120ms ease;
	}
	.os-avatar-edit {
		bottom: -0.25rem;
		right: -0.25rem;
		background-color: var(--button-bg);
		color: var(--button-color);
	}
	.os-avatar-remove {
		top: -0.25rem;
		right: -0.25rem;
		background-color: var(--center-channel-color);
		color: var(--center-channel-bg);
	}

	.os-title {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--center-channel-color);
		line-height: 1.2;
		letter-spacing: -0.02em;
	}

	.os-slug {
		font-size: 0.8125rem;
		font-family: var(--font-mono);
		color: var(--surface-muted);
		margin-top: 0.125rem;
	}

	/* Stats */
	.os-stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: 0.875rem;
	}

	.os-stat {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		padding: 1rem 1.125rem;
		border-radius: 0.875rem;
		border: 1px solid var(--surface-border);
		background-color: var(--surface-bg);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}

	.os-stat-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.625rem;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--surface-border) 50%, var(--center-channel-bg));
		color: var(--surface-muted);
	}

	.os-stat-value {
		font-size: 1.0625rem;
		font-weight: 700;
		color: var(--center-channel-color);
		line-height: 1.2;
	}

	.os-stat-label {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-weight: 500;
		margin-top: 0.0625rem;
	}

	/* Cards */
	.os-card {
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		background-color: var(--surface-bg);
		overflow: hidden;
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}

	.os-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1.125rem 1.375rem;
		border-bottom: 1px solid var(--surface-border);
	}

	.os-card-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--surface-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.os-card-count {
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.1875rem 0.5rem;
		border-radius: 9999px;
		background-color: color-mix(in srgb, var(--surface-border) 50%, var(--center-channel-bg));
		color: var(--surface-muted);
	}

	.os-card-body {
		padding: 1.375rem;
	}

	/* Edit form */
	.os-edit-grid {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.os-field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.os-field-label {
		font-size: 0.75rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
	}

	.os-edit-actions {
		display: flex;
		gap: 0.5rem;
		padding-top: 0.75rem;
	}

	/* Invite bar */
	.os-invite-bar {
		display: flex;
		gap: 0.5rem;
		padding: 1rem 1.375rem;
		border-bottom: 1px solid var(--surface-border);
		background-color: color-mix(in srgb, var(--surface-border) 15%, var(--surface-bg));
	}

	/* Member list */
	.os-member-list {
		display: flex;
		flex-direction: column;
	}

	.os-member {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.875rem 1.375rem;
		border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 70%, transparent);
		transition: background-color 80ms ease;
	}
	.os-member:last-child { border-bottom: none; }
	.os-member:hover { background-color: color-mix(in srgb, var(--surface-border) 15%, var(--surface-bg)); }

	.os-member-left {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
		flex: 1;
	}

	.os-member-avatar {
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.os-member-avatar-fallback {
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.75rem;
		font-weight: 600;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-bg));
		color: var(--center-channel-color);
	}

	.os-member-avatar-pending {
		background-color: color-mix(in srgb, var(--surface-border) 50%, var(--center-channel-bg));
		color: var(--surface-muted);
	}

	.os-member-info {
		min-width: 0;
	}

	.os-member-name {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--center-channel-color);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.os-member-email {
		font-size: 0.75rem;
		color: var(--surface-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.os-member-right {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
	}

	/* Role controls */
	.os-role-trigger {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 0.625rem;
		border-radius: 0.375rem;
		border: 1px solid var(--surface-border);
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
		transition: border-color 120ms ease;
	}
	.os-role-trigger:hover { border-color: color-mix(in srgb, var(--surface-border) 50%, var(--center-channel-color)); }

	.os-role-dropdown {
		position: absolute;
		right: 0;
		top: 100%;
		margin-top: 0.25rem;
		z-index: 20;
		width: 8rem;
		padding: 0.25rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--surface-bg);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
	}

	.os-role-option {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 0.375rem 0.5rem;
		border-radius: 0.375rem;
		font-size: 0.8125rem;
		color: var(--center-channel-color);
		background: transparent;
		cursor: pointer;
		transition: background-color 80ms ease;
	}
	.os-role-option:hover { background-color: var(--control-hover-bg); }

	.os-role-badge {
		padding: 0.25rem 0.5rem;
		border-radius: 0.375rem;
		font-size: 0.6875rem;
		font-weight: 600;
		background-color: color-mix(in srgb, var(--surface-border) 50%, var(--center-channel-bg));
		color: var(--surface-muted);
	}

	.os-member-action {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.375rem;
		border-radius: 0.375rem;
		color: var(--surface-muted);
		background: transparent;
		cursor: pointer;
		transition: color 80ms ease, background-color 80ms ease;
	}
	.os-member-action:hover {
		color: var(--center-channel-color);
		background-color: var(--control-hover-bg);
	}

	.os-member-remove {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.375rem;
		border-radius: 0.375rem;
		color: var(--error-text-color);
		background: transparent;
		cursor: pointer;
		transition: background-color 80ms ease;
	}
	.os-member-remove:hover {
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
	}

	@media (max-width: 640px) {
		.os-header { flex-direction: column; align-items: flex-start; }
		.os-invite-bar { flex-direction: column; }
		.os-member { flex-direction: column; align-items: flex-start; }
		.os-member-right { align-self: flex-end; }
		.os-stats { grid-template-columns: 1fr 1fr; }
	}
</style>
