<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { formatCpuMilli, formatMemoryBytes } from '$lib/quantity';
	import { Loader2, RefreshCw, Server, X, Trash2 } from 'lucide-svelte';

	interface NodeItem {
		id: string;
		name: string;
		schedulable: boolean;
		notes: string | null;
		cpuCapacity: string | null;
		memoryCapacity: string | null;
		labels: Record<string, string> | null;
		lastSeenAt: string | null;
		_count: { assignments: number };
		usage: { cpuMilli: number; memoryBytes: number; pods: number };
	}

	interface Assignment {
		id: string;
		organizationId: string;
		mode: 'allow' | 'deny';
		cpuLimit: string | null;
		memoryLimit: string | null;
		maxServices: number | null;
		organization: { id: string; name: string; slug: string; avatarUrl: string | null };
	}

	interface NodeDetail extends NodeItem {
		assignments: Assignment[];
		perOrgUsage: Array<{ orgId: string; cpuMilli: number; memBytes: number; pods: number }>;
	}

	interface OrgLite {
		id: string;
		name: string;
		slug: string;
		avatarUrl?: string;
	}

	let nodes = $state<NodeItem[]>([]);
	let loading = $state(true);
	let syncing = $state(false);
	let selectedNode = $state<NodeDetail | null>(null);
	let detailLoading = $state(false);
	let orgs = $state<OrgLite[]>([]);

	// Add-assignment form
	let addOrgId = $state('');
	let addMode = $state<'allow' | 'deny'>('allow');
	let addCpuLimit = $state('');
	let addMemoryLimit = $state('');
	let addMaxServices = $state('');
	let savingAssignment = $state(false);

	async function loadNodes() {
		loading = true;
		try {
			const res = await apiFetch('/apiv1/admin/nodes');
			if (!res.ok) throw new Error('Failed to load nodes');
			nodes = await res.json();
		} catch (e) {
			toasts.add({ message: e instanceof Error ? e.message : 'Failed', variant: 'error' });
		} finally {
			loading = false;
		}
	}

	async function loadOrgs() {
		try {
			const res = await apiFetch('/apiv1/admin/organizations?limit=100');
			if (!res.ok) return;
			const body = await res.json();
			orgs = body.organizations || [];
		} catch {}
	}

	async function syncNow() {
		syncing = true;
		try {
			const res = await apiFetch('/apiv1/admin/nodes/sync', { method: 'POST' });
			if (!res.ok) throw new Error('Sync failed');
			await loadNodes();
			toasts.add({ message: 'Nodes synced from cluster', variant: 'success' });
		} catch (e) {
			toasts.add({ message: e instanceof Error ? e.message : 'Sync failed', variant: 'error' });
		} finally {
			syncing = false;
		}
	}

	async function openNode(id: string) {
		detailLoading = true;
		selectedNode = null;
		try {
			const res = await apiFetch(`/apiv1/admin/nodes/${id}`);
			if (!res.ok) throw new Error('Failed to load node');
			selectedNode = await res.json();
		} catch (e) {
			toasts.add({ message: e instanceof Error ? e.message : 'Failed', variant: 'error' });
		} finally {
			detailLoading = false;
		}
	}

	function closeDetail() {
		selectedNode = null;
		addOrgId = '';
		addMode = 'allow';
		addCpuLimit = '';
		addMemoryLimit = '';
		addMaxServices = '';
	}

	async function toggleSchedulable(node: NodeItem) {
		try {
			const res = await apiFetch(`/apiv1/admin/nodes/${node.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ schedulable: !node.schedulable })
			});
			if (!res.ok) throw new Error('Failed');
			await loadNodes();
			if (selectedNode?.id === node.id) await openNode(node.id);
		} catch (e) {
			toasts.add({ message: e instanceof Error ? e.message : 'Failed', variant: 'error' });
		}
	}

	async function saveAssignment() {
		if (!selectedNode || !addOrgId) return;
		savingAssignment = true;
		try {
			const body: Record<string, unknown> = { mode: addMode };
			if (addCpuLimit.trim()) body.cpuLimit = addCpuLimit.trim();
			if (addMemoryLimit.trim()) body.memoryLimit = addMemoryLimit.trim();
			if (String(addMaxServices).trim()) body.maxServices = parseInt(String(addMaxServices), 10);
			const res = await apiFetch(`/apiv1/admin/nodes/${selectedNode.id}/assignments/${addOrgId}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) throw new Error('Failed to save assignment');
			await openNode(selectedNode.id);
			await loadNodes();
			addOrgId = '';
			addCpuLimit = '';
			addMemoryLimit = '';
			addMaxServices = '';
			toasts.add({ message: 'Assignment saved', variant: 'success' });
		} catch (e) {
			toasts.add({ message: e instanceof Error ? e.message : 'Failed', variant: 'error' });
		} finally {
			savingAssignment = false;
		}
	}

	async function deleteAssignment(a: Assignment) {
		if (!selectedNode) return;
		if (!confirm(`Remove ${a.organization.name} from this node?`)) return;
		try {
			const res = await apiFetch(
				`/apiv1/admin/nodes/${selectedNode.id}/assignments/${a.organizationId}`,
				{ method: 'DELETE' }
			);
			if (!res.ok) throw new Error('Failed');
			await openNode(selectedNode.id);
			await loadNodes();
		} catch (e) {
			toasts.add({ message: e instanceof Error ? e.message : 'Failed', variant: 'error' });
		}
	}

	const assignableOrgs = $derived(
		selectedNode
			? orgs.filter((o) => !selectedNode!.assignments.some((a) => a.organizationId === o.id))
			: orgs
	);

	onMount(() => {
		loadNodes();
		loadOrgs();
	});
</script>

<div class="flex items-center justify-between mb-4">
	<div class="text-sm" style="color: var(--surface-muted);">
		{nodes.length} node{nodes.length === 1 ? '' : 's'} in cluster
	</div>
	<button
		class="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium border transition hover:bg-[var(--control-bg)]"
		style="border-color: var(--surface-border);"
		onclick={syncNow}
		disabled={syncing}
	>
		{#if syncing}
			<Loader2 class="h-4 w-4 animate-spin" />
		{:else}
			<RefreshCw class="h-4 w-4" />
		{/if}
		Sync from cluster
	</button>
</div>

{#if loading}
	<div class="flex justify-center py-12">
		<Loader2 class="h-8 w-8 animate-spin text-primary-600" />
	</div>
{:else if nodes.length === 0}
	<div class="rounded-2xl border p-8 text-center" style="border-color: var(--surface-border);">
		<Server class="h-10 w-10 mx-auto mb-2" style="color: var(--surface-muted);" />
		<p class="text-sm" style="color: var(--surface-muted);">
			No nodes synced yet. Click "Sync from cluster" to import them.
		</p>
	</div>
{:else}
	<div class="rounded-2xl border overflow-hidden" style="border-color: var(--surface-border);">
		<table class="w-full text-sm">
			<thead style="background-color: var(--control-bg);">
				<tr>
					<th class="text-left px-4 py-2 font-medium">Name</th>
					<th class="text-left px-4 py-2 font-medium">Status</th>
					<th class="text-left px-4 py-2 font-medium">CPU used</th>
					<th class="text-left px-4 py-2 font-medium">Memory used</th>
					<th class="text-left px-4 py-2 font-medium">Pods</th>
					<th class="text-left px-4 py-2 font-medium">Assignments</th>
				</tr>
			</thead>
			<tbody>
				{#each nodes as node}
					<tr
						class="border-t cursor-pointer hover:bg-[var(--control-bg)]"
						style="border-color: var(--surface-border);"
						onclick={() => openNode(node.id)}
					>
						<td class="px-4 py-3 font-medium">{node.name}</td>
						<td class="px-4 py-3">
							<span
								class="inline-flex items-center rounded-full px-2 py-0.5 text-xs"
								style={node.schedulable
									? 'background-color: #dcfce7; color: #166534;'
									: 'background-color: #fee2e2; color: #991b1b;'}
							>
								{node.schedulable ? 'Schedulable' : 'Cordoned'}
							</span>
						</td>
						<td class="px-4 py-3">
							{formatCpuMilli(node.usage.cpuMilli)}
							{#if node.cpuCapacity}
								<span style="color: var(--surface-muted);">/ {node.cpuCapacity}</span>
							{/if}
						</td>
						<td class="px-4 py-3">
							{formatMemoryBytes(node.usage.memoryBytes)}
							{#if node.memoryCapacity}
								<span style="color: var(--surface-muted);">/ {node.memoryCapacity}</span>
							{/if}
						</td>
						<td class="px-4 py-3">{node.usage.pods}</td>
						<td class="px-4 py-3">{node._count.assignments}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

{#if selectedNode || detailLoading}
	<div
		class="fixed inset-0 z-40 bg-black/40 flex justify-end"
		onclick={closeDetail}
		onkeydown={(e) => e.key === 'Escape' && closeDetail()}
		role="dialog"
		tabindex="-1"
	>
		<div
			class="w-full max-w-xl h-full overflow-y-auto p-6"
			style="background-color: var(--center-channel-bg);"
			onclick={(e) => e.stopPropagation()}
			role="document"
		>
			{#if detailLoading || !selectedNode}
				<div class="flex justify-center py-12">
					<Loader2 class="h-6 w-6 animate-spin" />
				</div>
			{:else}
				<div class="flex items-center justify-between mb-4">
					<div>
						<h2 class="text-lg font-bold">{selectedNode.name}</h2>
						<p class="text-xs" style="color: var(--surface-muted);">
							{selectedNode.usage.pods} pods · {formatCpuMilli(selectedNode.usage.cpuMilli)} · {formatMemoryBytes(
								selectedNode.usage.memoryBytes
							)}
						</p>
					</div>
					<button onclick={closeDetail} class="p-1 rounded hover:bg-[var(--control-bg)]">
						<X class="h-5 w-5" />
					</button>
				</div>

				<div class="flex gap-2 mb-6">
					<button
						class="rounded-xl border px-3 py-1.5 text-sm"
						style="border-color: var(--surface-border);"
						onclick={() => toggleSchedulable(selectedNode!)}
					>
						{selectedNode.schedulable ? 'Cordon' : 'Uncordon'}
					</button>
				</div>

				<h3 class="text-sm font-semibold mb-2">Organization assignments</h3>
				{#if selectedNode.assignments.length === 0}
					<p class="text-xs mb-4" style="color: var(--surface-muted);">
						No assignments. Any org can schedule here. Add an allow-assignment to restrict.
					</p>
				{:else}
					<div class="space-y-2 mb-4">
						{#each selectedNode.assignments as a}
							<div class="rounded-xl border p-3" style="border-color: var(--surface-border);">
								<div class="flex items-start justify-between">
									<div>
										<div class="flex items-center gap-2">
											<span class="font-medium">{a.organization.name}</span>
											<span
												class="inline-flex items-center rounded-full px-2 py-0.5 text-xs"
												style={a.mode === 'allow'
													? 'background-color: #dcfce7; color: #166534;'
													: 'background-color: #fee2e2; color: #991b1b;'}
											>
												{a.mode}
											</span>
										</div>
										<div class="text-xs mt-1" style="color: var(--surface-muted);">
											CPU: {a.cpuLimit || '∞'} · Memory: {a.memoryLimit || '∞'} · Services: {a.maxServices ??
												'∞'}
										</div>
									</div>
									<button
										class="p-1 rounded hover:bg-[var(--control-bg)]"
										onclick={() => deleteAssignment(a)}
									>
										<Trash2 class="h-4 w-4" />
									</button>
								</div>
							</div>
						{/each}
					</div>
				{/if}

				<div class="rounded-xl border p-3" style="border-color: var(--surface-border);">
					<h4 class="text-sm font-semibold mb-2">Add / update assignment</h4>
					<div class="grid grid-cols-2 gap-2">
						<label class="col-span-2 text-xs">
							Organization
							<select
								bind:value={addOrgId}
								class="w-full rounded-lg border px-2 py-1 text-sm"
								style="border-color: var(--surface-border); background-color: var(--center-channel-bg);"
							>
								<option value="">Select org…</option>
								{#each assignableOrgs as o}
									<option value={o.id}>{o.name}</option>
								{/each}
							</select>
						</label>
						<label class="text-xs">
							Mode
							<select
								bind:value={addMode}
								class="w-full rounded-lg border px-2 py-1 text-sm"
								style="border-color: var(--surface-border); background-color: var(--center-channel-bg);"
							>
								<option value="allow">allow</option>
								<option value="deny">deny</option>
							</select>
						</label>
						<label class="text-xs">
							Max services
							<input
								type="number"
								bind:value={addMaxServices}
								placeholder="∞"
								class="w-full rounded-lg border px-2 py-1 text-sm"
								style="border-color: var(--surface-border); background-color: var(--center-channel-bg);"
							/>
						</label>
						<label class="text-xs">
							CPU limit (e.g. 2, 500m)
							<input
								bind:value={addCpuLimit}
								placeholder="unlimited"
								class="w-full rounded-lg border px-2 py-1 text-sm"
								style="border-color: var(--surface-border); background-color: var(--center-channel-bg);"
							/>
						</label>
						<label class="text-xs">
							Memory limit (e.g. 4Gi)
							<input
								bind:value={addMemoryLimit}
								placeholder="unlimited"
								class="w-full rounded-lg border px-2 py-1 text-sm"
								style="border-color: var(--surface-border); background-color: var(--center-channel-bg);"
							/>
						</label>
					</div>
					<button
						class="mt-3 w-full rounded-xl px-3 py-2 text-sm font-medium"
						style="background-color: var(--primary-600); color: white;"
						disabled={!addOrgId || savingAssignment}
						onclick={saveAssignment}
					>
						{savingAssignment ? 'Saving…' : 'Save assignment'}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}
