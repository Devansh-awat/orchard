<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { apiFetch, user, toasts } from '$lib/stores';
	import { ArrowLeft, Loader2, Pencil, Camera, X, UserPlus, Trash2, ChevronDown, Check, Mail } from 'lucide-svelte';
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

	const organizationSlug = $derived($page.params.slug);
	const canEditOrg = $derived(currentUserRole === 'owner' || currentUserRole === 'admin');
	const canInvite = $derived(currentUserRole === 'owner' || currentUserRole === 'admin');
	const isOwner = $derived(currentUserRole === 'owner');

	const orgAvatar = new AvatarBuilder({
		src: () => organization?.avatarUrl,
		delayMs: 120
	});

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

			// Fetch current user's role
			const roleResponse = await apiFetch(`/apiv1/organizations/${data.id}/members/me`);
			if (roleResponse.ok) {
				const roleData = await roleResponse.json();
				currentUserRole = roleData.role;

				// Fetch pending invitations if user can invite
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

			toasts.add({
				title: 'Organization updated',
				color: 'success'
			});

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
			toasts.add({
				title: 'Invalid file type',
				description: 'Only JPEG, PNG, GIF, and WebP images are allowed',
				color: 'error'
			});
			return;
		}

		if (file.size > 5 * 1024 * 1024) {
			toasts.add({
				title: 'File too large',
				description: 'Maximum file size is 5MB',
				color: 'error'
			});
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

			if (!response.ok) {
				throw new Error('Failed to upload avatar');
			}

			toasts.add({
				title: 'Avatar updated',
				color: 'success'
			});

			fetchOrganization();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to upload avatar',
				color: 'error'
			});
		} finally {
			uploadingAvatar = false;
			if (avatarInput) avatarInput.value = '';
		}
	}

	async function deleteAvatar() {
		if (!organization || !canEditOrg) return;

		deletingAvatar = true;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/avatar`, {
				method: 'DELETE'
			});

			if (!response.ok) {
				throw new Error('Failed to delete avatar');
			}

			toasts.add({
				title: 'Avatar removed',
				color: 'success'
			});

			fetchOrganization();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to delete avatar',
				color: 'error'
			});
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
				body: JSON.stringify({
					email: newMemberEmail,
					role: newMemberRole
				})
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to add member');
			}

			toasts.add({
				title: 'Member added',
				color: 'success'
			});

			newMemberEmail = '';
			newMemberRole = 'member';
			await fetchOrganization();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to add member',
				color: 'error'
			});
		} finally {
			addingMember = false;
		}
	}

	async function removeMember(memberId: string) {
		if (!organization) return;

		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/members/${memberId}`, {
				method: 'DELETE'
			});

			if (!response.ok) {
				throw new Error('Failed to remove member');
			}

			toasts.add({
				title: 'Member removed',
				color: 'success'
			});

			fetchOrganization();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to remove member',
				color: 'error'
			});
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

			if (!response.ok) {
				throw new Error('Failed to update member role');
			}

			toasts.add({
				title: 'Role updated',
				color: 'success'
			});

			fetchOrganization();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update role',
				color: 'error'
			});
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
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/invitations/${invitationId}/resend`, {
				method: 'POST'
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to resend invitation');
			}

			toasts.add({
				title: 'Invitation resent',
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to resend invitation',
				color: 'error'
			});
		} finally {
			resendingInvitationId = null;
		}
	}

	async function cancelInvitation(invitationId: string) {
		if (!organization) return;

		cancellingInvitationId = invitationId;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/invitations/${invitationId}`, {
				method: 'DELETE'
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to cancel invitation');
			}

			toasts.add({
				title: 'Invitation cancelled',
				color: 'success'
			});

			invitations = invitations.filter(inv => inv.id !== invitationId);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to cancel invitation',
				color: 'error'
			});
		} finally {
			cancellingInvitationId = null;
		}
	}

	onMount(() => {
		fetchOrganization();
	});
</script>

<div class="p-6">
	<button
		onclick={() => window.history.back()}
		class="mb-6 inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 cursor-pointer"
	>
		<ArrowLeft class="h-4 w-4" />
		Back to workspace
	</button>

	{#if error}
		<div class="alert alert-error mb-6">{error}</div>
	{/if}

	{#if loading}
		<div class="flex justify-center py-12">
			<Loader2 class="h-8 w-8 animate-spin text-primary-600" />
		</div>
	{:else if organization}
		<div class="space-y-6">
			<!-- Header -->
			<div
				class="rounded-3xl border p-6 shadow-sm"
				style="
					background-color: var(--surface-bg);
					border-color: var(--surface-border);
					color: var(--center-channel-color);
				"
			>
				<div class="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
					<div class="flex items-center gap-4">
						<div class="relative">
							<div class="h-16 w-16 overflow-hidden rounded-2xl ring-2 ring-gray-200 dark:ring-gray-700">
								<img
									{...orgAvatar.image}
									alt={organization.name}
									class="h-full w-full object-cover"
								/>
								<span
									{...orgAvatar.fallback}
									class="flex h-full w-full items-center justify-center bg-primary-100 text-2xl font-bold text-primary-700 dark:bg-primary-900/30 dark:text-primary-200"
								>
									{organization.name[0]}
								</span>
							</div>
							{#if canEditOrg}
								<input
									bind:this={avatarInput}
									type="file"
									accept="image/jpeg,image/png,image/gif,image/webp"
									class="hidden"
									onchange={uploadAvatar}
								/>
								<button
									onclick={() => avatarInput?.click()}
									disabled={uploadingAvatar}
									class="absolute -bottom-2 -right-2 rounded-full border border-white bg-primary-600 p-2 text-white shadow-sm transition hover:bg-primary-700 disabled:opacity-70 dark:border-gray-900"
								>
									{#if uploadingAvatar}
										<Loader2 class="h-4 w-4 animate-spin" />
									{:else}
										<Camera class="h-4 w-4" />
									{/if}
								</button>
								{#if organization.avatarUrl}
									<button
										onclick={deleteAvatar}
										disabled={deletingAvatar}
										class="absolute -top-2 -right-2 rounded-full border border-white bg-gray-900 p-2 text-white shadow-sm transition hover:bg-gray-800 disabled:opacity-70 dark:border-gray-900"
									>
										{#if deletingAvatar}
											<Loader2 class="h-4 w-4 animate-spin" />
										{:else}
											<X class="h-4 w-4" />
										{/if}
									</button>
								{/if}
							{/if}
						</div>
						<div>
							<p class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">Organization</p>
							<h1 class="text-2xl font-bold" style="color: var(--center-channel-color);">{organization.name}</h1>
							{#if organization.description}
								<p class="mt-1 text-sm" style="color: var(--surface-muted);">{organization.description}</p>
							{:else}
								<p class="mt-1 text-sm italic" style="color: var(--surface-muted);">No description provided</p>
							{/if}
							<div class="mt-3 flex flex-wrap gap-3 text-xs" style="color: var(--surface-muted);">
								<span
									class="rounded-full px-3 py-1 font-medium"
									style="background-color: var(--control-bg); border: 1px solid var(--surface-border); color: var(--center-channel-color);"
								>
									Slug: {organization.slug}
								</span>
								<span
									class="rounded-full px-3 py-1 font-medium"
									style="background-color: var(--control-bg); border: 1px solid var(--surface-border); color: var(--center-channel-color);"
								>
									{organization.workspaces?.length || 0} workspaces
								</span>
								<span
									class="rounded-full px-3 py-1 font-medium"
									style="background-color: var(--control-bg); border: 1px solid var(--surface-border); color: var(--center-channel-color);"
								>
									{members.length} members
								</span>
							</div>
						</div>
					</div>
					{#if canEditOrg && !isEditing}
						<button onclick={startEditing} class="btn btn-primary self-start md:self-center">
							<Pencil class="h-4 w-4" />
							Edit details
						</button>
					{/if}
				</div>
			</div>

			<div class="grid gap-6 lg:grid-cols-[1.6fr,1fr]">
				<div class="space-y-6">
					<!-- Organization Details -->
					<div class="card">
						<div class="card-header flex items-center justify-between">
							<h2 class="font-semibold">Organization Details</h2>
							{#if canEditOrg && isEditing}
								<div class="flex gap-2">
									<button onclick={cancelEditing} class="btn btn-secondary btn-sm">Cancel</button>
									<button onclick={saveOrganization} disabled={updating} class="btn btn-primary btn-sm">
										{#if updating}
											<Loader2 class="h-4 w-4 animate-spin" />
										{/if}
										Save changes
									</button>
								</div>
							{/if}
						</div>
						<div class="card-body">
							{#if isEditing}
								<div class="grid gap-4 md:grid-cols-2">
									<div class="md:col-span-2 space-y-2">
										<label class="block text-sm font-medium">Organization Name</label>
										<input type="text" bind:value={editingName} class="input" />
									</div>
									<div class="md:col-span-2 space-y-2">
										<label class="block text-sm font-medium">Description</label>
										<textarea bind:value={editingDescription} rows="3" class="input"></textarea>
									</div>
								</div>
							{:else}
								<div class="grid gap-4 sm:grid-cols-2">
									<div
										class="rounded-2xl border p-4"
										style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
									>
										<p class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">Slug</p>
										<p class="mt-2 font-mono text-sm" style="color: var(--center-channel-color);">{organization.slug}</p>
									</div>
									<div
										class="rounded-2xl border p-4"
										style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
									>
										<p class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">Workspaces</p>
										<p class="mt-2 text-lg font-semibold" style="color: var(--center-channel-color);">
											{organization.workspaces?.length || 0}
										</p>
									</div>
									<div
										class="rounded-2xl border p-4"
										style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
									>
										<p class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">Members</p>
										<p class="mt-2 text-lg font-semibold" style="color: var(--center-channel-color);">{members.length}</p>
									</div>
									<div
										class="rounded-2xl border p-4"
										style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
									>
										<p class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">Role</p>
										<p class="mt-2">
											<span class="badge {currentUserRole === 'owner' ? 'badge-success' : 'badge-neutral'}">
												{currentUserRole ? currentUserRole.charAt(0).toUpperCase() + currentUserRole.slice(1) : 'Member'}
											</span>
										</p>
									</div>
								</div>
							{/if}
						</div>
					</div>

					<!-- Members -->
					<div class="card">
						<div class="card-header">
							<div class="flex items-center justify-between gap-4">
								<h2 class="font-semibold" style="color: var(--center-channel-color);">Members ({members.length})</h2>
								{#if canInvite}
									<span class="text-xs" style="color: var(--surface-muted);">Owners can change roles & remove members</span>
								{/if}
							</div>
						</div>
						<div class="card-body space-y-6">
							{#if canInvite}
								<div
									class="flex flex-col gap-3 rounded-2xl border border-dashed p-4 md:flex-row md:items-center"
									style="border-color: var(--surface-border); background-color: var(--control-bg);"
								>
									<input
										type="email"
										bind:value={newMemberEmail}
										placeholder="Email address"
										class="input flex-1 rounded-xl"
										style="background-color: var(--center-channel-bg); color: var(--center-channel-color); border-color: var(--surface-border);"
									/>
									<div class="flex items-center gap-3">
										<div class="relative">
											<button
												type="button"
												onclick={() => (inviteRoleOpen = !inviteRoleOpen)}
												class="flex w-32 items-center justify-between overflow-hidden rounded-xl border px-3 py-2 text-sm transition"
												style="background-color: var(--control-bg); color: var(--center-channel-color); border-color: var(--surface-border);"
											>
												<span>{roleOptions.find((r) => r.value === newMemberRole)?.label || 'Role'}</span>
												<ChevronDown class="h-4 w-4 shrink-0" />
											</button>
											{#if inviteRoleOpen}
												<div
													class="absolute z-20 mt-1 w-40 rounded-xl border p-2 shadow"
													style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
													transition:scale={{ duration: 150, start: 0.96 }}
												>
													{#each roleOptions as option}
														<button
															type="button"
															onclick={() => {
																newMemberRole = option.value;
																inviteRoleOpen = false;
															}}
															class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]"
														>
															<span>{option.label}</span>
															{#if newMemberRole === option.value}
																<Check class="h-4 w-4 text-primary-600" />
															{/if}
														</button>
													{/each}
												</div>
											{/if}
										</div>
										<button onclick={addMember} disabled={addingMember || !newMemberEmail} class="btn btn-primary whitespace-nowrap">
											{#if addingMember}
												<Loader2 class="h-4 w-4 animate-spin" />
											{:else}
												<UserPlus class="h-4 w-4" />
											{/if}
											Add member
										</button>
									</div>
								</div>
							{/if}

							<div class="space-y-2">
								{#each members as member}
									<div
										class="flex flex-col gap-3 rounded-2xl border p-4 transition hover:-translate-y-0.5 hover:shadow-sm sm:flex-row sm:items-center sm:justify-between"
										style="border-color: var(--surface-border); background-color: var(--surface-bg); color: var(--center-channel-color);"
									>
										<div class="flex items-center gap-3">
											{#if member.user.imageUrl}
												<img
													src={member.user.imageUrl}
													alt={member.user.firstName || member.user.email}
													class="h-10 w-10 rounded-full object-cover"
												/>
											{:else}
												<div
													class="flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold"
													style="background-color: color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-bg)); color: var(--center-channel-color);"
												>
													{member.user.firstName?.[0] || member.user.email[0].toUpperCase()}
												</div>
											{/if}
											<div>
												<p class="font-semibold" style="color: var(--center-channel-color);">
													{member.user.firstName} {member.user.lastName || ''}
												</p>
												<p class="text-sm" style="color: var(--surface-muted);">{member.user.email}</p>
											</div>
										</div>
										<div class="flex items-center gap-3">
											{#if isOwner}
												<div class="relative">
													<button
														type="button"
														onclick={() =>
															(memberRoleOpen = memberRoleOpen === member.id ? null : member.id)}
														class="flex w-32 items-center justify-between overflow-hidden rounded-xl border px-3 py-2 text-sm transition"
														style="background-color: var(--control-bg); color: var(--center-channel-color); border-color: var(--surface-border);"
													>
														<span>{roleOptions.find((r) => r.value === member.role)?.label || member.role}</span>
														<ChevronDown class="h-4 w-4 shrink-0" />
													</button>
													{#if memberRoleOpen === member.id}
														<div
															class="absolute z-20 mt-1 w-40 rounded-xl border p-2 shadow"
															style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
															transition:scale={{ duration: 150, start: 0.96 }}
														>
															{#each roleOptions as option}
																<button
																	type="button"
																	onclick={() => {
																		updateMemberRole(member.id, option.value);
																		memberRoleOpen = null;
																	}}
																	class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-[color-mix(in_srgb,var(--surface-border)_40%,transparent)]"
																>
																	<span>{option.label}</span>
																	{#if member.role === option.value}
																		<Check class="h-4 w-4 text-primary-600" />
																	{/if}
																</button>
															{/each}
														</div>
													{/if}
												</div>
											{:else}
												<span class="badge badge-neutral">
													{member.role.charAt(0).toUpperCase() + member.role.slice(1)}
												</span>
											{/if}
											{#if canInvite && member.role !== 'owner'}
												<button onclick={() => removeMember(member.id)} class="btn btn-ghost btn-sm text-red-500">
													<Trash2 class="h-4 w-4" />
												</button>
											{/if}
										</div>
									</div>
								{/each}
							</div>
						</div>
					</div>

					<!-- Pending Invitations -->
					{#if canInvite}
						<div class="card">
							<div class="card-header">
								<h2 class="font-semibold" style="color: var(--center-channel-color);">
									Pending Invitations ({invitations.length})
								</h2>
							</div>
							<div class="card-body">
								{#if invitations.length === 0}
									<p class="text-sm" style="color: var(--surface-muted);">No pending invitations</p>
								{:else}
									<div class="space-y-2">
										{#each invitations as invitation}
											<div
												class="flex flex-col gap-3 rounded-2xl border p-4 transition hover:-translate-y-0.5 hover:shadow-sm sm:flex-row sm:items-center sm:justify-between"
												style="border-color: var(--surface-border); background-color: var(--surface-bg); color: var(--center-channel-color);"
											>
												<div class="flex items-center gap-3">
													<div
														class="flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold"
														style="background-color: color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-bg)); color: var(--center-channel-color);"
													>
														{invitation.email[0].toUpperCase()}
													</div>
													<div>
														<p class="font-semibold" style="color: var(--center-channel-color);">
															{invitation.email}
														</p>
														<p class="text-sm" style="color: var(--surface-muted);">
															Invited {new Date(invitation.createdAt).toLocaleDateString()} • Expires {new Date(invitation.expiresAt).toLocaleDateString()}
														</p>
													</div>
												</div>
												<div class="flex items-center gap-3">
													<span class="badge badge-neutral">
														{invitation.role.charAt(0).toUpperCase() + invitation.role.slice(1)}
													</span>
													<button
														onclick={() => resendInvitation(invitation.id)}
														disabled={resendingInvitationId === invitation.id}
														class="btn btn-ghost btn-sm"
														title="Resend invitation"
													>
														{#if resendingInvitationId === invitation.id}
															<Loader2 class="h-4 w-4 animate-spin" />
														{:else}
															<Mail class="h-4 w-4" />
														{/if}
													</button>
													<button
														onclick={() => cancelInvitation(invitation.id)}
														disabled={cancellingInvitationId === invitation.id}
														class="btn btn-ghost btn-sm text-red-500"
														title="Cancel invitation"
													>
														{#if cancellingInvitationId === invitation.id}
															<Loader2 class="h-4 w-4 animate-spin" />
														{:else}
															<Trash2 class="h-4 w-4" />
														{/if}
													</button>
												</div>
											</div>
										{/each}
									</div>
								{/if}
							</div>
						</div>
					{/if}
				</div>

				<div class="space-y-6">
					<!-- Current User Card -->
					{#if $user}
						<div class="card">
							<div class="card-header">
								<h2 class="text-lg font-semibold" style="color: var(--center-channel-color);">Your access</h2>
							</div>
							<div class="card-body">
								<div class="flex items-center gap-4">
									{#if $user.imageUrl}
										<img src={$user.imageUrl} alt={$user.name || 'User'} class="h-12 w-12 rounded-full object-cover" />
									{:else}
										<div
											class="flex h-12 w-12 items-center justify-center rounded-full"
											style="background-color: color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-bg)); color: var(--center-channel-color);"
										>
											<span class="text-lg font-medium">{$user.firstName?.[0] || 'U'}</span>
										</div>
									{/if}
									<div>
										<p class="font-semibold" style="color: var(--center-channel-color);">
											{$user.name || $user.firstName || $user.username}
										</p>
										<p class="text-sm" style="color: var(--surface-muted);">{$user.email}</p>
										{#if currentUserRole}
											<span class="badge {currentUserRole === 'owner' ? 'badge-success' : 'badge-neutral'} mt-1">
												{currentUserRole.charAt(0).toUpperCase() + currentUserRole.slice(1)}
											</span>
										{/if}
									</div>
								</div>
							</div>
						</div>
					{/if}

					<!-- Billing (Owner only) -->
					{#if isOwner}
						<div class="card">
							<div class="card-header">
								<h2 class="font-semibold" style="color: var(--center-channel-color);">Billing</h2>
							</div>
							<div class="card-body">
								<div
									class="flex items-center justify-between rounded-2xl border p-4"
									style="border-color: var(--surface-border); background-color: var(--control-bg); color: var(--center-channel-color);"
								>
									<div>
										<p class="font-medium">Current Plan</p>
										<p class="text-sm" style="color: var(--surface-muted);">Your organization is on the Enterprise plan</p>
									</div>
									<span class="badge badge-success">Enterprise</span>
								</div>
							</div>
						</div>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>
