<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		Loader2,
		Search,
		Shield,
		Trash2,
		Pencil,
		ChevronLeft,
		ChevronRight
	} from 'lucide-svelte';
	import { Modal, Button, Field, Input, Badge, EmptyState } from '$lib/components/ui';
	import { avatarUrl } from '$lib/avatar';

	interface UserItem {
		id: string;
		email: string;
		username: string;
		firstName?: string;
		lastName?: string;
		imageUrl?: string;
		isSuperAdmin: boolean;
		createdAt: string;
		_count: {
			organizationMembers: number;
			workspaceMembers: number;
		};
	}

	let users = $state<UserItem[]>([]);
	let loading = $state(true);
	let total = $state(0);
	let currentPage = $state(1);
	let totalPages = $state(1);
	let searchQuery = $state('');
	let searchTimeout: ReturnType<typeof setTimeout>;

	// Edit modal state
	let editingUser = $state<UserItem | null>(null);
	let editFirstName = $state('');
	let editLastName = $state('');
	let editIsSuperAdmin = $state(false);
	let saving = $state(false);

	// Delete confirmation
	let deletingUser = $state<UserItem | null>(null);
	let deleting = $state(false);

	async function fetchUsers(page: number = 1) {
		loading = true;
		try {
			const params = new URLSearchParams({ page: String(page), limit: '20' });
			if (searchQuery) params.set('search', searchQuery);
			const response = await apiFetch(`/apiv1/admin/users?${params}`);
			if (!response.ok) throw new Error('Failed to fetch users');
			const data = await response.json();
			users = data.users;
			total = data.total;
			currentPage = data.page;
			totalPages = data.totalPages;
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to fetch users',
				color: 'error'
			});
		} finally {
			loading = false;
		}
	}

	function handleSearch() {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			fetchUsers(1);
		}, 300);
	}

	function openEdit(user: UserItem) {
		editingUser = user;
		editFirstName = user.firstName || '';
		editLastName = user.lastName || '';
		editIsSuperAdmin = user.isSuperAdmin;
	}

	function closeEdit() {
		editingUser = null;
	}

	async function saveUser() {
		if (!editingUser) return;
		saving = true;
		try {
			const response = await apiFetch(`/apiv1/admin/users/${editingUser.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					firstName: editFirstName,
					lastName: editLastName,
					isSuperAdmin: editIsSuperAdmin
				})
			});
			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to update user');
			}
			toasts.add({ title: 'User updated', color: 'success' });
			closeEdit();
			fetchUsers(currentPage);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update user',
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}

	async function confirmDelete() {
		if (!deletingUser) return;
		deleting = true;
		try {
			const response = await apiFetch(`/apiv1/admin/users/${deletingUser.id}`, {
				method: 'DELETE'
			});
			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to delete user');
			}
			toasts.add({ title: 'User deleted', color: 'success' });
			deletingUser = null;
			fetchUsers(currentPage);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to delete user',
				color: 'error'
			});
		} finally {
			deleting = false;
		}
	}

	onMount(() => {
		fetchUsers();
	});
</script>

<!-- Search -->
<div class="mb-4 flex items-center gap-3">
	<div class="relative flex-1">
		<Search
			class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
			style="color: var(--surface-muted);"
		/>
		<Input
			type="text"
			bind:value={searchQuery}
			oninput={handleSearch}
			placeholder="Search users by name, email, or username..."
			class="w-full pl-10"
		/>
	</div>
	<span class="text-sm whitespace-nowrap" style="color: var(--surface-muted);">
		{total} total users
	</span>
</div>

<!-- Table -->
<div
	class="rounded-2xl border overflow-hidden"
	style="border-color: var(--surface-border); background-color: var(--surface-bg);"
>
	{#if loading}
		<div class="flex justify-center py-12">
			<Loader2 class="h-6 w-6 animate-spin text-primary-600" />
		</div>
	{:else if users.length === 0}
		<EmptyState title="No users found" />
	{:else}
		<div class="overflow-x-auto">
			<table class="w-full text-sm">
				<thead>
					<tr style="border-bottom: 1px solid var(--surface-border); color: var(--surface-muted);">
						<th class="px-4 py-3 text-left font-medium">User</th>
						<th class="px-4 py-3 text-left font-medium">Username</th>
						<th class="px-4 py-3 text-left font-medium">Role</th>
						<th class="px-4 py-3 text-left font-medium">Orgs</th>
						<th class="px-4 py-3 text-left font-medium">Workspaces</th>
						<th class="px-4 py-3 text-left font-medium">Created</th>
						<th class="px-4 py-3 text-right font-medium">Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each users as user (user.id)}
						<tr
							style="border-bottom: 1px solid var(--surface-border); color: var(--center-channel-color);"
							class="transition hover:bg-[color-mix(in_srgb,var(--surface-border)_20%,transparent)]"
						>
							<td class="px-4 py-3">
								<div class="flex items-center gap-3">
									<img
										src={avatarUrl(user)}
										alt={user.firstName || user.email}
										class="h-8 w-8 rounded-full object-cover"
									/>
									<div>
										<p class="font-medium">
											{user.firstName || ''}
											{user.lastName || ''}
											{#if !user.firstName && !user.lastName}
												<span style="color: var(--surface-muted);">No name</span>
											{/if}
										</p>
										<p class="text-xs" style="color: var(--surface-muted);">{user.email}</p>
									</div>
								</div>
							</td>
							<td class="px-4 py-3 font-mono text-xs">{user.username}</td>
							<td class="px-4 py-3">
								{#if user.isSuperAdmin}
									<Badge tone="success"><Shield class="mr-1 h-3 w-3" />Admin</Badge>
								{:else}
									<Badge tone="neutral">User</Badge>
								{/if}
							</td>
							<td class="px-4 py-3">{user._count.organizationMembers}</td>
							<td class="px-4 py-3">{user._count.workspaceMembers}</td>
							<td class="px-4 py-3 text-xs" style="color: var(--surface-muted);">
								{new Date(user.createdAt).toLocaleDateString()}
							</td>
							<td class="px-4 py-3">
								<div class="flex items-center justify-end gap-1">
									<Button
										variant="ghost"
										size="sm"
										onclick={() => openEdit(user)}
										title="Edit user"
									>
										<Pencil class="h-4 w-4" />
									</Button>
									<Button
										variant="ghost"
										size="sm"
										style="color: var(--error-text-color);"
										onclick={() => (deletingUser = user)}
										title="Delete user"
									>
										<Trash2 class="h-4 w-4" />
									</Button>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<!-- Pagination -->
{#if totalPages > 1}
	<div class="mt-4 flex items-center justify-center gap-2">
		<Button
			variant="ghost"
			size="sm"
			onclick={() => fetchUsers(currentPage - 1)}
			disabled={currentPage <= 1}
		>
			<ChevronLeft class="h-4 w-4" />
		</Button>
		<span class="text-sm" style="color: var(--surface-muted);">
			Page {currentPage} of {totalPages}
		</span>
		<Button
			variant="ghost"
			size="sm"
			onclick={() => fetchUsers(currentPage + 1)}
			disabled={currentPage >= totalPages}
		>
			<ChevronRight class="h-4 w-4" />
		</Button>
	</div>
{/if}

<Modal
	bind:open={
		() => editingUser !== null,
		(v) => {
			if (!v) closeEdit();
		}
	}
	title="Edit user"
>
	{#if editingUser}
		<div class="space-y-4">
			<Field label="Email" for="edit-user-email">
				<Input id="edit-user-email" value={editingUser.email} disabled class="w-full opacity-60" />
			</Field>
			<div class="grid grid-cols-2 gap-3">
				<Field label="First name" for="edit-user-first-name">
					<Input id="edit-user-first-name" bind:value={editFirstName} class="w-full" />
				</Field>
				<Field label="Last name" for="edit-user-last-name">
					<Input id="edit-user-last-name" bind:value={editLastName} class="w-full" />
				</Field>
			</div>
			<div class="flex items-center gap-3">
				<button
					type="button"
					onclick={() => (editIsSuperAdmin = !editIsSuperAdmin)}
					class="flex h-5 w-9 items-center rounded-full p-0.5 transition-colors"
					style={editIsSuperAdmin
						? 'background-color: var(--color-primary-600);'
						: 'background-color: var(--surface-border);'}
				>
					<div
						class="h-4 w-4 rounded-full bg-white shadow transition-transform"
						style={editIsSuperAdmin ? 'transform: translateX(16px);' : ''}
					></div>
				</button>
				<span class="text-sm font-medium">Super admin</span>
			</div>
		</div>
	{/if}
	{#snippet footer()}
		<Button variant="secondary" onclick={closeEdit}>Cancel</Button>
		<Button variant="primary" onclick={saveUser} loading={saving}>Save changes</Button>
	{/snippet}
</Modal>

<Modal
	bind:open={
		() => deletingUser !== null,
		(v) => {
			if (!v) deletingUser = null;
		}
	}
	title="Delete user"
	size="sm"
>
	{#if deletingUser}
		<p class="text-sm mb-1" style="color: var(--surface-muted);">
			Are you sure you want to delete this user?
		</p>
		<p class="text-sm font-medium mb-4">
			{deletingUser.firstName || ''}
			{deletingUser.lastName || ''} ({deletingUser.email})
		</p>
		<p class="text-xs" style="color: var(--error-text-color);">
			This action cannot be undone. All their data will be permanently deleted.
		</p>
	{/if}
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (deletingUser = null)}>Cancel</Button>
		<Button variant="danger" onclick={confirmDelete} loading={deleting}>Delete</Button>
	{/snippet}
</Modal>
