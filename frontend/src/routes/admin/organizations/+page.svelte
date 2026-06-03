<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		Loader2,
		Search,
		Trash2,
		Pencil,
		Plus,
		X,
		ChevronLeft,
		ChevronRight,
		Gauge,
	} from 'lucide-svelte';
	import { formatCpuMilli, formatMemoryBytes } from '$lib/quantity';

	interface OrgItem {
		id: string;
		name: string;
		slug: string;
		description?: string;
		avatarUrl?: string;
		plan?: string;
		createdAt: string;
		creator?: {
			id: string;
			email: string;
			username: string;
			firstName?: string;
			lastName?: string;
		};
		_count: {
			members: number;
			workspaces: number;
		};
	}

	let organizations = $state<OrgItem[]>([]);
	let loading = $state(true);
	let total = $state(0);
	let currentPage = $state(1);
	let totalPages = $state(1);
	let searchQuery = $state('');
	let searchTimeout: ReturnType<typeof setTimeout>;

	const PLAN_OPTIONS = ['free', 'pro', 'enterprise'] as const;

	// Create modal
	let showCreate = $state(false);
	let createName = $state('');
	let createSlug = $state('');
	let createDescription = $state('');
	let createImageUrl = $state('');
	let createPlan = $state<string>('');
	let createPrimaryOwnerEmail = $state('');
	let creating = $state(false);

	// Edit modal
	let editingOrg = $state<OrgItem | null>(null);
	let editName = $state('');
	let editDescription = $state('');
	let saving = $state(false);

	// Delete confirmation
	let deletingOrg = $state<OrgItem | null>(null);
	let deleting = $state(false);

	// Quota modal
	let quotaOrg = $state<OrgItem | null>(null);
	let quotaLoading = $state(false);
	let quotaSaving = $state(false);
	let quotaUsage = $state<{ cpuMilli: number; memoryBytes: number; pods: number; services: number } | null>(null);
	let qCpu = $state<string>('');
	let qMemMi = $state<string>('');
	let qPods = $state<string>('');
	let qServices = $state<string>('');
	let qDefaultCpu = $state<string>('');
	let qDefaultMemMi = $state<string>('');

	// Quota connections (shared-pool linking)
	let qConnections = $state<Array<{ id: string; name: string; slug: string }>>([]);
	let qConnectSearch = $state('');
	let qConnectResults = $state<OrgItem[]>([]);
	let qConnectBusy = $state(false);
	let qConnectSearchTimeout: ReturnType<typeof setTimeout>;

	async function openQuota(org: OrgItem) {
		quotaOrg = org;
		quotaLoading = true;
		quotaUsage = null;
		qCpu = qMemMi = qPods = qServices = qDefaultCpu = qDefaultMemMi = '';
		qConnections = [];
		qConnectSearch = '';
		qConnectResults = [];
		try {
			const res = await apiFetch(`/apiv1/admin/organizations/${org.id}/quota`);
			if (!res.ok) throw new Error('Failed to load quota');
			const data = await res.json();
			quotaUsage = data.usage;
			qCpu = data.org.cpuLimitMilli ? String(data.org.cpuLimitMilli) : '';
			qMemMi = data.org.memoryLimitBytes ? String(Math.round(data.org.memoryLimitBytes / (1024 * 1024))) : '';
			qPods = data.org.maxPods ? String(data.org.maxPods) : '';
			qServices = data.org.maxServices ? String(data.org.maxServices) : '';
			qDefaultCpu = data.org.defaultPodCpuMilli ? String(data.org.defaultPodCpuMilli) : '';
			qDefaultMemMi = data.org.defaultPodMemoryBytes ? String(Math.round(data.org.defaultPodMemoryBytes / (1024 * 1024))) : '';
			qConnections = data.connections ?? [];
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', color: 'error' });
			quotaOrg = null;
		} finally {
			quotaLoading = false;
		}
	}

	function closeQuota() {
		quotaOrg = null;
	}

	function parseIntOrNull(v: string | number | null | undefined): number | null {
		const t = String(v ?? '').trim();
		if (!t) return null;
		const n = parseInt(t, 10);
		return Number.isFinite(n) && n > 0 ? n : null;
	}

	function handleConnectSearch() {
		clearTimeout(qConnectSearchTimeout);
		qConnectSearchTimeout = setTimeout(async () => {
			const q = qConnectSearch.trim();
			if (!q) {
				qConnectResults = [];
				return;
			}
			try {
				const params = new URLSearchParams({ page: '1', limit: '8', search: q });
				const res = await apiFetch(`/apiv1/admin/organizations?${params}`);
				if (!res.ok) return;
				const data = await res.json();
				const connectedIds = new Set(qConnections.map((c) => c.id));
				qConnectResults = (data.organizations as OrgItem[]).filter(
					(o) => o.id !== quotaOrg?.id && !connectedIds.has(o.id),
				);
			} catch {
				qConnectResults = [];
			}
		}, 250);
	}

	async function refreshQuota() {
		if (!quotaOrg) return;
		const res = await apiFetch(`/apiv1/admin/organizations/${quotaOrg.id}/quota`);
		if (!res.ok) return;
		const data = await res.json();
		quotaUsage = data.usage;
		qCpu = data.org.cpuLimitMilli ? String(data.org.cpuLimitMilli) : '';
		qMemMi = data.org.memoryLimitBytes ? String(Math.round(data.org.memoryLimitBytes / (1024 * 1024))) : '';
		qPods = data.org.maxPods ? String(data.org.maxPods) : '';
		qServices = data.org.maxServices ? String(data.org.maxServices) : '';
		qDefaultCpu = data.org.defaultPodCpuMilli ? String(data.org.defaultPodCpuMilli) : '';
		qDefaultMemMi = data.org.defaultPodMemoryBytes ? String(Math.round(data.org.defaultPodMemoryBytes / (1024 * 1024))) : '';
		qConnections = data.connections ?? [];
	}

	async function connectOrg(other: OrgItem) {
		if (!quotaOrg) return;
		qConnectBusy = true;
		try {
			const res = await apiFetch(`/apiv1/admin/organizations/${quotaOrg.id}/quota/connect`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ otherOrgId: other.id }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to connect');
			}
			toasts.add({
				title: 'Connected',
				description: `${quotaOrg.name} and ${other.name} now share the same quota pool.`,
				color: 'success',
			});
			qConnectSearch = '';
			qConnectResults = [];
			await refreshQuota();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', color: 'error' });
		} finally {
			qConnectBusy = false;
		}
	}

	async function disconnectQuota() {
		if (!quotaOrg) return;
		qConnectBusy = true;
		try {
			const res = await apiFetch(`/apiv1/admin/organizations/${quotaOrg.id}/quota/disconnect`, {
				method: 'POST',
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to disconnect');
			}
			toasts.add({ title: 'Disconnected', description: 'Quota pool is no longer shared.', color: 'success' });
			await refreshQuota();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', color: 'error' });
		} finally {
			qConnectBusy = false;
		}
	}

	async function saveQuota() {
		if (!quotaOrg) return;
		quotaSaving = true;
		try {
			const memMi = parseIntOrNull(qMemMi);
			const defMemMi = parseIntOrNull(qDefaultMemMi);
			const body = {
				cpuLimitMilli: parseIntOrNull(qCpu),
				memoryLimitBytes: memMi === null ? null : memMi * 1024 * 1024,
				maxPods: parseIntOrNull(qPods),
				maxServices: parseIntOrNull(qServices),
				defaultPodCpuMilli: parseIntOrNull(qDefaultCpu),
				defaultPodMemoryBytes: defMemMi === null ? null : defMemMi * 1024 * 1024,
			};
			const res = await apiFetch(`/apiv1/admin/organizations/${quotaOrg.id}/quota`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error('Save failed');
			toasts.add({ title: 'Saved', description: 'Quotas applied to cluster', color: 'success' });
			closeQuota();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', color: 'error' });
		} finally {
			quotaSaving = false;
		}
	}

	async function fetchOrganizations(page: number = 1) {
		loading = true;
		try {
			const params = new URLSearchParams({ page: String(page), limit: '20' });
			if (searchQuery) params.set('search', searchQuery);
			const response = await apiFetch(`/apiv1/admin/organizations?${params}`);
			if (!response.ok) throw new Error('Failed to fetch organizations');
			const data = await response.json();
			organizations = data.organizations;
			total = data.total;
			currentPage = data.page;
			totalPages = data.totalPages;
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to fetch organizations',
				color: 'error',
			});
		} finally {
			loading = false;
		}
	}

	function handleSearch() {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			fetchOrganizations(1);
		}, 300);
	}

	function generateSlug() {
		createSlug = createName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '');
	}

	function openCreateModal() {
		showCreate = true;
		createName = '';
		createSlug = '';
		createDescription = '';
		createImageUrl = '';
		createPlan = '';
		createPrimaryOwnerEmail = '';
	}

	async function createOrganization() {
		if (!createName || !createSlug) return;
		creating = true;
		try {
			const response = await apiFetch('/apiv1/admin/organizations', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: createName,
					slug: createSlug,
					description: createDescription || undefined,
					avatarUrl: createImageUrl || undefined,
					plan: createPlan || undefined,
					primaryOwnerEmail: createPrimaryOwnerEmail.trim() || undefined,
				}),
			});
			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to create organization');
			}
			const data = await response.json();
			const inviteLink = data.inviteLink;
			toasts.add({
				title: 'Organization created',
				description: inviteLink
					? 'Share the invite link with the primary owner so they can join.'
					: undefined,
				color: 'success',
			});
			if (inviteLink) {
				await navigator.clipboard.writeText(inviteLink);
				toasts.add({ title: 'Invite link copied to clipboard', color: 'success' });
			}
			showCreate = false;
			createName = '';
			createSlug = '';
			createDescription = '';
			createImageUrl = '';
			createPlan = '';
			createPrimaryOwnerEmail = '';
			fetchOrganizations(1);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to create organization',
				color: 'error',
			});
		} finally {
			creating = false;
		}
	}

	function openEdit(org: OrgItem) {
		editingOrg = org;
		editName = org.name;
		editDescription = org.description || '';
	}

	function closeEdit() {
		editingOrg = null;
	}

	async function saveOrg() {
		if (!editingOrg) return;
		saving = true;
		try {
			const response = await apiFetch(`/apiv1/admin/organizations/${editingOrg.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: editName, description: editDescription }),
			});
			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to update organization');
			}
			toasts.add({ title: 'Organization updated', color: 'success' });
			closeEdit();
			fetchOrganizations(currentPage);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update organization',
				color: 'error',
			});
		} finally {
			saving = false;
		}
	}

	async function confirmDelete() {
		if (!deletingOrg) return;
		deleting = true;
		try {
			const response = await apiFetch(`/apiv1/admin/organizations/${deletingOrg.id}`, {
				method: 'DELETE',
			});
			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to delete organization');
			}
			toasts.add({ title: 'Organization deleted', color: 'success' });
			deletingOrg = null;
			fetchOrganizations(currentPage);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to delete organization',
				color: 'error',
			});
		} finally {
			deleting = false;
		}
	}

	onMount(() => {
		fetchOrganizations();
	});
</script>

<!-- Search + Create -->
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
			placeholder="Search organizations by name or slug..."
			class="input w-full pl-10"
		/>
	</div>
	<span class="text-sm whitespace-nowrap" style="color: var(--surface-muted);">
		{total} total
	</span>
	<button onclick={openCreateModal} class="btn btn-primary whitespace-nowrap">
		<Plus class="h-4 w-4" />
		Create
	</button>
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
	{:else if organizations.length === 0}
		<div class="p-8 text-center" style="color: var(--surface-muted);">
			No organizations found
		</div>
	{:else}
		<div class="overflow-x-auto">
			<table class="w-full text-sm">
				<thead>
					<tr style="border-bottom: 1px solid var(--surface-border); color: var(--surface-muted);">
						<th class="px-4 py-3 text-left font-medium">Organization</th>
						<th class="px-4 py-3 text-left font-medium">Slug</th>
						<th class="px-4 py-3 text-left font-medium">Members</th>
						<th class="px-4 py-3 text-left font-medium">Workspaces</th>
						<th class="px-4 py-3 text-left font-medium">Creator</th>
						<th class="px-4 py-3 text-left font-medium">Created</th>
						<th class="px-4 py-3 text-right font-medium">Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each organizations as org}
						<tr
							style="border-bottom: 1px solid var(--surface-border); color: var(--center-channel-color);"
							class="transition hover:bg-[color-mix(in_srgb,var(--surface-border)_20%,transparent)]"
						>
							<td class="px-4 py-3">
								<div class="flex items-center gap-3">
									{#if org.avatarUrl}
										<img
											src={org.avatarUrl}
											alt={org.name}
											class="h-8 w-8 rounded-lg object-cover"
										/>
									{:else}
										<div
											class="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-semibold"
											style="background-color: var(--control-bg); color: var(--center-channel-color);"
										>
											{org.name[0].toUpperCase()}
										</div>
									{/if}
									<div>
										<p class="font-medium">{org.name}</p>
										{#if org.description}
											<p
												class="text-xs truncate max-w-[200px]"
												style="color: var(--surface-muted);"
											>
												{org.description}
											</p>
										{/if}
									</div>
								</div>
							</td>
							<td class="px-4 py-3 font-mono text-xs">{org.slug}</td>
							<td class="px-4 py-3">{org._count.members}</td>
							<td class="px-4 py-3">{org._count.workspaces}</td>
							<td class="px-4 py-3 text-xs" style="color: var(--surface-muted);">
								{#if org.creator}
									{org.creator.firstName || org.creator.username || org.creator.email}
								{:else}
									<span class="italic">System</span>
								{/if}
							</td>
							<td class="px-4 py-3 text-xs" style="color: var(--surface-muted);">
								{new Date(org.createdAt).toLocaleDateString()}
							</td>
							<td class="px-4 py-3">
								<div class="flex items-center justify-end gap-1">
									<button
										onclick={() => openQuota(org)}
										class="btn btn-ghost btn-sm"
										title="Resource quotas"
									>
										<Gauge class="h-4 w-4" />
									</button>
									<button
										onclick={() => openEdit(org)}
										class="btn btn-ghost btn-sm"
										title="Edit organization"
									>
										<Pencil class="h-4 w-4" />
									</button>
									<button
										onclick={() => (deletingOrg = org)}
										class="btn btn-ghost btn-sm text-red-500"
										title="Delete organization"
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
			onclick={() => fetchOrganizations(currentPage - 1)}
			disabled={currentPage <= 1}
			class="btn btn-ghost btn-sm"
		>
			<ChevronLeft class="h-4 w-4" />
		</button>
		<span class="text-sm" style="color: var(--surface-muted);">
			Page {currentPage} of {totalPages}
		</span>
		<button
			onclick={() => fetchOrganizations(currentPage + 1)}
			disabled={currentPage >= totalPages}
			class="btn btn-ghost btn-sm"
		>
			<ChevronRight class="h-4 w-4" />
		</button>
	</div>
{/if}

<!-- Create Modal -->
{#if showCreate}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
		<div
			class="w-full max-w-md rounded-2xl border p-6 shadow-xl"
			style="background-color: var(--center-channel-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
		>
			<div class="flex items-center justify-between mb-4">
				<h3 class="text-lg font-semibold">Create Organization</h3>
				<button onclick={() => (showCreate = false)} class="btn btn-ghost btn-sm">
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="space-y-4">
				<div>
					<label class="block text-sm font-medium mb-1">Name</label>
					<input
						type="text"
						bind:value={createName}
						oninput={generateSlug}
						placeholder="My Organization"
						class="input w-full"
					/>
				</div>
				<div>
					<label class="block text-sm font-medium mb-1">Slug</label>
					<input
						type="text"
						bind:value={createSlug}
						placeholder="my-organization"
						class="input w-full font-mono text-sm"
					/>
				</div>
				<div>
					<label class="block text-sm font-medium mb-1">Description (optional)</label>
					<textarea
						bind:value={createDescription}
						rows="3"
						placeholder="A brief description..."
						class="input w-full"
					></textarea>
				</div>
				<div>
					<label class="block text-sm font-medium mb-1">Image URL (optional)</label>
					<input
						type="url"
						bind:value={createImageUrl}
						placeholder="https://..."
						class="input w-full"
					/>
				</div>
				<div>
					<label class="block text-sm font-medium mb-1">Plan (optional)</label>
					<select bind:value={createPlan} class="input w-full">
						<option value="">None</option>
						{#each PLAN_OPTIONS as opt}
							<option value={opt}>{opt}</option>
						{/each}
					</select>
				</div>
				<div>
					<label for="create-primary-owner-email" class="block text-sm font-medium mb-1">Primary owner email (optional)</label>
					<input
						id="create-primary-owner-email"
						type="email"
						bind:value={createPrimaryOwnerEmail}
						placeholder="client@example.com"
						class="input w-full"
					/>
					<p class="text-xs mt-1" style="color: var(--surface-muted);">
						If they have an account, they become owner now. Otherwise they’re invited and become owner when they accept.
					</p>
				</div>
			</div>

			<div class="mt-6 flex justify-end gap-2">
				<button onclick={() => (showCreate = false)} class="btn btn-secondary">Cancel</button>
				<button
					onclick={createOrganization}
					disabled={creating || !createName || !createSlug}
					class="btn btn-primary"
				>
					{#if creating}
						<Loader2 class="h-4 w-4 animate-spin" />
					{/if}
					Create
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Edit Modal -->
{#if editingOrg}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
		<div
			class="w-full max-w-md rounded-2xl border p-6 shadow-xl"
			style="background-color: var(--center-channel-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
		>
			<div class="flex items-center justify-between mb-4">
				<h3 class="text-lg font-semibold">Edit Organization</h3>
				<button onclick={closeEdit} class="btn btn-ghost btn-sm">
					<X class="h-4 w-4" />
				</button>
			</div>

			<div class="space-y-4">
				<div>
					<label class="block text-sm font-medium mb-1">Name</label>
					<input type="text" bind:value={editName} class="input w-full" />
				</div>
				<div>
					<label class="block text-sm font-medium mb-1">Description</label>
					<textarea bind:value={editDescription} rows="3" class="input w-full"></textarea>
				</div>
			</div>

			<div class="mt-6 flex justify-end gap-2">
				<button onclick={closeEdit} class="btn btn-secondary">Cancel</button>
				<button onclick={saveOrg} disabled={saving} class="btn btn-primary">
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
{#if deletingOrg}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
		<div
			class="w-full max-w-sm rounded-2xl border p-6 shadow-xl"
			style="background-color: var(--center-channel-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
		>
			<h3 class="text-lg font-semibold mb-2">Delete Organization</h3>
			<p class="text-sm mb-1" style="color: var(--surface-muted);">
				Are you sure you want to delete this organization?
			</p>
			<p class="text-sm font-medium mb-4">{deletingOrg.name} ({deletingOrg.slug})</p>
			<p class="text-xs text-red-500 mb-4">
				This will permanently delete the organization and all its workspaces, projects, and
				deployments.
			</p>
			<div class="flex justify-end gap-2">
				<button onclick={() => (deletingOrg = null)} class="btn btn-secondary">Cancel</button>
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

<!-- Quota Modal -->
{#if quotaOrg}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
		<div
			class="w-full max-w-lg rounded-2xl border p-6 shadow-xl"
			style="background-color: var(--center-channel-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
		>
			<div class="flex items-center justify-between mb-4">
				<div>
					<h3 class="text-lg font-semibold">Resource quotas</h3>
					<p class="text-xs" style="color: var(--surface-muted);">{quotaOrg.name}</p>
				</div>
				<button onclick={closeQuota} class="btn btn-ghost btn-sm"><X class="h-4 w-4" /></button>
			</div>

			{#if quotaLoading}
				<div class="flex justify-center py-10"><Loader2 class="h-6 w-6 animate-spin" /></div>
			{:else}
				{#if quotaUsage}
					<div class="rounded-xl border p-3 mb-4" style="border-color: var(--surface-border);">
						<p class="text-xs font-medium mb-1" style="color: var(--surface-muted);">Current usage</p>
						<div class="grid grid-cols-2 gap-2 text-sm">
							<div>CPU: <strong>{formatCpuMilli(quotaUsage.cpuMilli)}</strong></div>
							<div>Memory: <strong>{formatMemoryBytes(quotaUsage.memoryBytes)}</strong></div>
							<div>Pods: <strong>{quotaUsage.pods}</strong></div>
							<div>Services: <strong>{quotaUsage.services}</strong></div>
						</div>
					</div>
				{/if}

				<p class="text-xs mb-3" style="color: var(--surface-muted);">
					Click <strong>Unlimited</strong> or leave blank to remove a cap. Limits apply across all projects in this org. Kubernetes enforces them at pod-admission time.
				</p>

				<div class="grid grid-cols-2 gap-3">
					<label class="text-xs">
						CPU (millicores)
						<div class="flex items-center gap-2 mt-1">
							<input type="number" bind:value={qCpu} placeholder="unlimited" class="input flex-1" />
							<button type="button" class="text-xs px-2 py-1 rounded border" style="border-color: var(--surface-border);" onclick={() => (qCpu = '')}>Unlimited</button>
						</div>
					</label>
					<label class="text-xs">
						Memory (MiB)
						<div class="flex items-center gap-2 mt-1">
							<input type="number" bind:value={qMemMi} placeholder="unlimited" class="input flex-1" />
							<button type="button" class="text-xs px-2 py-1 rounded border" style="border-color: var(--surface-border);" onclick={() => (qMemMi = '')}>Unlimited</button>
						</div>
					</label>
					<label class="text-xs">
						Max pods
						<div class="flex items-center gap-2 mt-1">
							<input type="number" bind:value={qPods} placeholder="unlimited" class="input flex-1" />
							<button type="button" class="text-xs px-2 py-1 rounded border" style="border-color: var(--surface-border);" onclick={() => (qPods = '')}>Unlimited</button>
						</div>
					</label>
					<label class="text-xs">
						Max services
						<div class="flex items-center gap-2 mt-1">
							<input type="number" bind:value={qServices} placeholder="unlimited" class="input flex-1" />
							<button type="button" class="text-xs px-2 py-1 rounded border" style="border-color: var(--surface-border);" onclick={() => (qServices = '')}>Unlimited</button>
						</div>
					</label>
				</div>

				<h4 class="text-sm font-semibold mt-4 mb-2">Per-pod defaults (LimitRange)</h4>
				<p class="text-xs mb-2" style="color: var(--surface-muted);">
					Applied to containers that don't specify requests. Required if CPU/memory quotas are set.
				</p>
				<div class="grid grid-cols-2 gap-3">
					<label class="text-xs">
						Default CPU / pod (millicores)
						<input type="number" bind:value={qDefaultCpu} placeholder="100" class="input w-full mt-1" />
					</label>
					<label class="text-xs">
						Default memory / pod (MiB)
						<input type="number" bind:value={qDefaultMemMi} placeholder="128" class="input w-full mt-1" />
					</label>
				</div>

				<h4 class="text-sm font-semibold mt-4 mb-2">Connected organizations</h4>
				<p class="text-xs mb-2" style="color: var(--surface-muted);">
					Connected orgs mirror the same caps and draw from the <strong>same usage pool</strong>.
					Connecting org A (10 CPU) to org B means both show 10 CPU, but the sum of their usage
					still cannot exceed 10.
				</p>

				{#if qConnections.length > 0}
					<div class="space-y-1 mb-3">
						{#each qConnections as conn}
							<div
								class="flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
								style="border-color: var(--surface-border);"
							>
								<div>
									<div class="font-medium">{conn.name}</div>
									<div class="font-mono text-xs" style="color: var(--surface-muted);">{conn.slug}</div>
								</div>
								<button
									type="button"
									onclick={disconnectQuota}
									disabled={qConnectBusy}
									class="btn btn-ghost btn-sm text-red-500"
									title="Disconnect from shared pool"
								>
									<X class="h-4 w-4" />
								</button>
							</div>
						{/each}
					</div>
				{:else}
					<p class="text-xs mb-2 italic" style="color: var(--surface-muted);">Not connected to any other org.</p>
				{/if}

				<div class="relative">
					<input
						type="text"
						bind:value={qConnectSearch}
						oninput={handleConnectSearch}
						placeholder="Search for an organization to connect..."
						class="input w-full"
					/>
					{#if qConnectResults.length > 0}
						<div
							class="mt-1 rounded-lg border overflow-hidden"
							style="border-color: var(--surface-border); background-color: var(--center-channel-bg);"
						>
							{#each qConnectResults as r}
								<button
									type="button"
									onclick={() => connectOrg(r)}
									disabled={qConnectBusy}
									class="w-full text-left px-3 py-2 text-sm hover:bg-[color-mix(in_srgb,var(--surface-border)_20%,transparent)] flex items-center justify-between"
								>
									<span>
										<span class="font-medium">{r.name}</span>
										<span class="font-mono text-xs ml-2" style="color: var(--surface-muted);">{r.slug}</span>
									</span>
									<Plus class="h-4 w-4" />
								</button>
							{/each}
						</div>
					{/if}
				</div>

				<div class="mt-6 flex justify-end gap-2">
					<button onclick={closeQuota} class="btn btn-secondary">Cancel</button>
					<button onclick={saveQuota} disabled={quotaSaving} class="btn btn-primary">
						{#if quotaSaving}<Loader2 class="h-4 w-4 animate-spin" />{/if}
						Save quotas
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

