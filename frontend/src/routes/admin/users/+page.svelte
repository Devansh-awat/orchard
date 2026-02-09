<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		Loader2,
		Search,
		Shield,
		Trash2,
		Pencil,
		X,
		Check,
		ChevronLeft,
		ChevronRight,
	} from 'lucide-svelte';

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
				color: 'error',
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
					isSuperAdmin: editIsSuperAdmin,
				}),
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
				color: 'error',
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
				method: 'DELETE',
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
				color: 'error',
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
		<input
			type="text"
			bind:value={searchQuery}
			oninput={handleSearch}
			placeholder="Search users by name, email, or username..."
			class="input w-full pl-10"
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
		<div class="p-8 text-center" style="color: var(--surface-muted);">
			No users found
		</div>
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
					{#each users as user}
						<tr
							style="border-bottom: 1px solid var(--surface-border); color: var(--center-channel-color);"
							class="transition hover:bg-[color-mix(in_srgb,var(--surface-border)_20%,transparent)]"
						>
							<td class="px-4 py-3">
								<div class="flex items-center gap-3">
									{#if user.imageUrl}
										<img
											src={user.imageUrl}
											alt={user.firstName || user.email}
											class="h-8 w-8 rounded-full object-cover"
										/>
									{:else}
										<div
											class="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold"
											style="background-color: var(--control-bg); color: var(--center-channel-color);"
										>
											{(user.firstName?.[0] || user.email[0]).toUpperCase()}
										</div>
									{/if}
									<div>
										<p class="font-medium">
											{user.firstName || ''} {user.lastName || ''}
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
									<span class="badge badge-success flex items-center gap-1 w-fit">
										<Shield class="h-3 w-3" />
										Admin
									</span>
								{:else}
									<span class="badge badge-neutral">User</span>
								{/if}
							</td>
							<td class="px-4 py-3">{user._count.organizationMembers}</td>
							<td class="px-4 py-3">{user._count.workspaceMembers}</td>
							<td class="px-4 py-3 text-xs" style="color: var(--surface-muted);">
								{new Date(user.createdAt).toLocaleDateString()}
							</td>
							<td class="px-4 py-3">
								<div class="flex items-center justify-end gap-1">
									<button
										onclick={() => openEdit(user)}
										class="btn btn-ghost btn-sm"
										title="Edit user"
									>
										<Pencil class="h-4 w-4" />
									</button>
									<button
										onclick={() => (deletingUser = user)}
										class="btn btn-ghost btn-sm text-red-500"
										title="Delete user"
									>
										<Trash2 class="h-4 w-4" />
									</button>
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
		<button
			onclick={() => fetchUsers(currentPage - 1)}
			disabled={currentPage <= 1}
			class="btn btn-ghost btn-sm"
		>
			<ChevronLeft class="h-4 w-4" />
		</button>
		<span class="text-sm" style="color: var(--surface-muted);">
			Page {currentPage} of {totalPages}
		</span>
		<button
			onclick={() => fetchUsers(currentPage + 1)}
			disabled={currentPage >= totalPages}
			class="btn btn-ghost btn-sm"
		>
			<ChevronRight class="h-4 w-4" />
		</button>
	</div>
{/if}

<!-- Edit Modal -->
{#if editingUser}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
		<div
			class="w-full max-w-md rounded-2xl border p-6 shadow-xl"
			style="background-color: var(--center-channel-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
		>
			<div class="flex items-center justify-between mb-4">
				<h3 class="text-lg font-semibold">Edit User</h3>
				<button onclick={closeEdit} class="btn btn-ghost btn-sm">
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="space-y-4">
				<div>
					<label class="block text-sm font-medium mb-1">Email</label>
					<input type="text" value={editingUser.email} disabled class="input w-full opacity-60" />
				</div>
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label class="block text-sm font-medium mb-1">First Name</label>
						<input type="text" bind:value={editFirstName} class="input w-full" />
					</div>
					<div>
						<label class="block text-sm font-medium mb-1">Last Name</label>
						<input type="text" bind:value={editLastName} class="input w-full" />
					</div>
				</div>
				<div class="flex items-center gap-3">
					<button
						type="button"
						onclick={() => (editIsSuperAdmin = !editIsSuperAdmin)}
						class="flex h-5 w-9 items-center rounded-full p-0.5 transition-colors"
						style={editIsSuperAdmin
							? 'background-color: var(--primary-600);'
							: 'background-color: var(--surface-border);'}
					>
						<div
							class="h-4 w-4 rounded-full bg-white shadow transition-transform"
							style={editIsSuperAdmin ? 'transform: translateX(16px);' : ''}
						></div>
					</button>
					<label class="text-sm font-medium">Super Admin</label>
				</div>
			</div>

			<div class="mt-6 flex justify-end gap-2">
				<button onclick={closeEdit} class="btn btn-secondary">Cancel</button>
				<button onclick={saveUser} disabled={saving} class="btn btn-primary">
					{#if saving}
						<Loader2 class="h-4 w-4 animate-spin" />
					{/if}
					Save Changes
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Delete Confirmation -->
{#if deletingUser}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
		<div
			class="w-full max-w-sm rounded-2xl border p-6 shadow-xl"
			style="background-color: var(--center-channel-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
		>
			<h3 class="text-lg font-semibold mb-2">Delete User</h3>
			<p class="text-sm mb-1" style="color: var(--surface-muted);">
				Are you sure you want to delete this user?
			</p>
			<p class="text-sm font-medium mb-4">
				{deletingUser.firstName || ''} {deletingUser.lastName || ''} ({deletingUser.email})
			</p>
			<p class="text-xs text-red-500 mb-4">
				This action cannot be undone. All their data will be permanently deleted.
			</p>
			<div class="flex justify-end gap-2">
				<button onclick={() => (deletingUser = null)} class="btn btn-secondary">Cancel</button>
				<button
					onclick={confirmDelete}
					disabled={deleting}
					class="btn bg-red-600 text-white hover:bg-red-700"
				>
					{#if deleting}
						<Loader2 class="h-4 w-4 animate-spin" />
					{/if}
					Delete
				</button>
			</div>
		</div>
	</div>
{/if}
