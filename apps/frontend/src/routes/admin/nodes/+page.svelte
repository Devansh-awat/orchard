<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { formatCpuMilli, formatMemoryBytes } from '$lib/quantity';
	import { Loader2, RefreshCw, Server, X, Trash2, Plus } from 'lucide-svelte';
	import { Button, Badge, Field, Input, Select, EmptyState } from '$lib/components/ui';
	import NodePoolsPanel from '$lib/components/admin/NodePoolsPanel.svelte';

	interface Taint {
		key: string;
		value: string | null;
		effect: string;
	}

	interface NodeItem {
		id: string;
		name: string;
		schedulable: boolean;
		notes: string | null;
		cpuCapacity: string | null;
		memoryCapacity: string | null;
		labels: Record<string, string> | null;
		taints: Taint[] | null;
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

	// Taint editor (drawer)
	let taintRows = $state<Taint[]>([]);
	let savingTaints = $state(false);
	// Label add form (drawer)
	let newLabelKey = $state('');
	let newLabelValue = $state('');
	let savingLabels = $state(false);

	async function loadNodes() {
		loading = true;
		try {
			const res = await apiFetch('/apiv1/admin/nodes');
			if (!res.ok) throw new Error('Failed to load nodes');
			nodes = await res.json();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
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
			toasts.add({ title: 'Nodes synced from cluster', color: 'success' });
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Sync failed', color: 'error' });
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
			taintRows = (selectedNode?.taints ?? []).map((t) => ({
				key: t.key,
				value: t.value ?? '',
				effect: t.effect || 'NoSchedule'
			}));
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
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
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
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
			toasts.add({ title: 'Assignment saved', color: 'success' });
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
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
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		}
	}

	function addTaintRow() {
		taintRows = [...taintRows, { key: '', value: '', effect: 'NoSchedule' }];
	}
	function removeTaintRow(i: number) {
		taintRows = taintRows.filter((_, idx) => idx !== i);
	}

	async function saveTaints() {
		if (!selectedNode) return;
		savingTaints = true;
		try {
			const taints = taintRows
				.filter((t) => t.key.trim())
				.map((t) => ({ key: t.key.trim(), value: (t.value ?? '').trim() || null, effect: t.effect }));
			const res = await apiFetch(`/apiv1/admin/nodes/${selectedNode.id}/taints`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ taints })
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.message || 'Failed to save taints');
			}
			await openNode(selectedNode.id);
			toasts.add({ title: 'Taints updated', color: 'success' });
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			savingTaints = false;
		}
	}

	async function patchLabels(labels: Record<string, string | null>) {
		if (!selectedNode) return;
		savingLabels = true;
		try {
			const res = await apiFetch(`/apiv1/admin/nodes/${selectedNode.id}/labels`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ labels })
			});
			if (!res.ok) throw new Error('Failed to update labels');
			await openNode(selectedNode.id);
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			savingLabels = false;
		}
	}

	async function addLabel() {
		if (!newLabelKey.trim()) return;
		await patchLabels({ [newLabelKey.trim()]: newLabelValue.trim() });
		newLabelKey = '';
		newLabelValue = '';
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
	<Button variant="secondary" onclick={syncNow} loading={syncing}>
		{#if !syncing}
			<RefreshCw class="h-4 w-4" />
		{/if}
		Sync from cluster
	</Button>
</div>

{#if loading}
	<div class="flex justify-center py-12">
		<Loader2 class="h-8 w-8 animate-spin text-primary-600" />
	</div>
{:else if nodes.length === 0}
	<div class="rounded-2xl border" style="border-color: var(--surface-border);">
		<EmptyState title="No nodes synced yet" description="Sync from cluster to import them.">
			{#snippet icon()}<Server class="h-10 w-10" />{/snippet}
		</EmptyState>
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
				{#each nodes as node (node.id)}
					<tr
						class="border-t cursor-pointer hover:bg-[var(--control-bg)]"
						style="border-color: var(--surface-border);"
						onclick={() => openNode(node.id)}
					>
						<td class="px-4 py-3 font-medium">{node.name}</td>
						<td class="px-4 py-3">
							<Badge tone={node.schedulable ? 'success' : 'error'}>
								{node.schedulable ? 'Schedulable' : 'Cordoned'}
							</Badge>
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

<NodePoolsPanel />

{#if selectedNode || detailLoading}
	<div
		class="fixed inset-0 bg-black/40 flex justify-end"
		style="z-index: var(--z-modal);"
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
					<Button variant="ghost" size="sm" onclick={closeDetail} aria-label="Close">
						<X class="h-5 w-5" />
					</Button>
				</div>

				<div class="flex gap-2 mb-6">
					<Button variant="secondary" size="sm" onclick={() => toggleSchedulable(selectedNode!)}>
						{selectedNode.schedulable ? 'Cordon' : 'Uncordon'}
					</Button>
				</div>

				<h3 class="text-sm font-semibold mb-2">Taints</h3>
				<p class="text-xs mb-2 text-muted">
					A tainted node repels workloads that don't tolerate it. Build a node pool that tolerates
					these taints to route specific workloads here.
				</p>
				<div class="space-y-2 mb-2">
					{#each taintRows as taint, i (i)}
						<div class="flex items-center gap-2">
							<Input bind:value={taint.key} placeholder="orchard.io/pool" class="flex-1 min-w-0" />
							<Input bind:value={taint.value} placeholder="background" class="flex-1 min-w-0" />
							<div class="w-44 shrink-0">
								<Select bind:value={taint.effect}>
									<option value="NoSchedule">NoSchedule</option>
									<option value="PreferNoSchedule">PreferNoSchedule</option>
									<option value="NoExecute">NoExecute</option>
								</Select>
							</div>
							<Button variant="ghost" size="sm" onclick={() => removeTaintRow(i)} aria-label="Remove taint">
								<X class="h-4 w-4" />
							</Button>
						</div>
					{/each}
				</div>
				<div class="flex gap-2 mb-6">
					<Button variant="ghost" size="sm" onclick={addTaintRow}><Plus class="h-4 w-4" /> Add taint</Button>
					<Button variant="secondary" size="sm" loading={savingTaints} onclick={saveTaints}>Save taints</Button>
				</div>

				<h3 class="text-sm font-semibold mb-2">Labels</h3>
				{#if selectedNode.labels && Object.keys(selectedNode.labels).length > 0}
					<div class="flex flex-wrap gap-1.5 mb-2">
						{#each Object.entries(selectedNode.labels) as [k, v] (k)}
							<span class="inline-flex items-center gap-1 rounded-md border border-edge bg-surface px-2 py-0.5 text-xs text-muted">
								<span class="font-mono">{k}{v ? `=${v}` : ''}</span>
								<button
									type="button"
									class="text-faint hover:text-fg"
									aria-label="Remove label {k}"
									onclick={() => patchLabels({ [k]: null })}
									disabled={savingLabels}
								>
									<X class="h-3 w-3" />
								</button>
							</span>
						{/each}
					</div>
				{/if}
				<div class="flex items-center gap-2 mb-6">
					<Input bind:value={newLabelKey} placeholder="orchard.io/pool" class="flex-1" />
					<Input bind:value={newLabelValue} placeholder="background" class="flex-1" />
					<Button variant="secondary" size="sm" loading={savingLabels} disabled={!newLabelKey.trim()} onclick={addLabel}>
						Add label
					</Button>
				</div>

				<h3 class="text-sm font-semibold mb-2">Organization assignments</h3>
				{#if selectedNode.assignments.length === 0}
					<p class="text-xs mb-4" style="color: var(--surface-muted);">
						No assignments. Any org can schedule here. Add an allow-assignment to restrict.
					</p>
				{:else}
					<div class="space-y-2 mb-4">
						{#each selectedNode.assignments as a (a.id)}
							<div class="rounded-xl border p-3" style="border-color: var(--surface-border);">
								<div class="flex items-start justify-between">
									<div>
										<div class="flex items-center gap-2">
											<span class="font-medium">{a.organization.name}</span>
											<Badge tone={a.mode === 'allow' ? 'success' : 'error'}>{a.mode}</Badge>
										</div>
										<div class="text-xs mt-1" style="color: var(--surface-muted);">
											CPU: {a.cpuLimit || '∞'} · Memory: {a.memoryLimit || '∞'} · Services: {a.maxServices ??
												'∞'}
										</div>
									</div>
									<Button
										variant="ghost"
										size="sm"
										style="color: var(--error-text-color);"
										onclick={() => deleteAssignment(a)}
										title="Remove assignment"
									>
										<Trash2 class="h-4 w-4" />
									</Button>
								</div>
							</div>
						{/each}
					</div>
				{/if}

				<div class="rounded-xl border p-3" style="border-color: var(--surface-border);">
					<h4 class="text-sm font-semibold mb-2">Add / update assignment</h4>
					<div class="grid grid-cols-2 gap-2">
						<div class="col-span-2">
							<Field label="Organization" for="assign-org">
								<Select id="assign-org" bind:value={addOrgId} class="w-full">
									<option value="">Select org…</option>
									{#each assignableOrgs as o (o.id)}
										<option value={o.id}>{o.name}</option>
									{/each}
								</Select>
							</Field>
						</div>
						<Field label="Mode" for="assign-mode">
							<Select id="assign-mode" bind:value={addMode} class="w-full">
								<option value="allow">allow</option>
								<option value="deny">deny</option>
							</Select>
						</Field>
						<Field label="Max services" for="assign-max-services">
							<Input
								id="assign-max-services"
								type="number"
								bind:value={addMaxServices}
								placeholder="∞"
								class="w-full"
							/>
						</Field>
						<Field label="CPU limit (e.g. 2, 500m)" for="assign-cpu-limit">
							<Input
								id="assign-cpu-limit"
								bind:value={addCpuLimit}
								placeholder="unlimited"
								class="w-full"
							/>
						</Field>
						<Field label="Memory limit (e.g. 4Gi)" for="assign-memory-limit">
							<Input
								id="assign-memory-limit"
								bind:value={addMemoryLimit}
								placeholder="unlimited"
								class="w-full"
							/>
						</Field>
					</div>
					<Button
						variant="primary"
						class="mt-3 w-full"
						disabled={!addOrgId}
						loading={savingAssignment}
						onclick={saveAssignment}
					>
						Save assignment
					</Button>
				</div>
			{/if}
		</div>
	</div>
{/if}
