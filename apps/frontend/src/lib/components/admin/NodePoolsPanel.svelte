<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		Button,
		Badge,
		Field,
		Input,
		Dropdown,
		Modal,
		EmptyState,
		ToggleRow
	} from '$lib/components/ui';
	import { Layers, Plus, Pencil, Trash2, X } from 'lucide-svelte';
	import UserspaceSchedulingToggle from './UserspaceSchedulingToggle.svelte';

	interface SelectorExpr {
		key: string;
		operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';
		values: string;
	}
	interface TolerationRow {
		key: string;
		operator: 'Exists' | 'Equal';
		value: string;
		effect: '' | 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
	}
	interface NodePool {
		id: string;
		name: string;
		slug: string;
		description: string | null;
		nodeSelector: Array<{ key: string; operator: string; values?: string[] }>;
		tolerations: Array<{ key?: string; operator?: string; value?: string; effect?: string }>;
		affinityMode: 'required' | 'preferred';
		userSelectable: boolean;
		_count: { deployments: number; jobs: number; databases: number };
	}

	let pools = $state<NodePool[]>([]);
	let loading = $state(true);
	let editing = $state<NodePool | null>(null);
	let modalOpen = $state(false);
	let saving = $state(false);

	let fName = $state('');
	let fDescription = $state('');
	let fAffinityMode = $state<'required' | 'preferred'>('preferred');
	let fUserSelectable = $state(false);
	let fSelectors = $state<SelectorExpr[]>([]);
	let fTolerations = $state<TolerationRow[]>([]);

	async function load() {
		loading = true;
		try {
			const res = await apiFetch('/apiv1/admin/node-pools');
			if (!res.ok) throw new Error('Failed to load node pools');
			pools = await res.json();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			loading = false;
		}
	}

	function openCreate() {
		editing = null;
		fName = '';
		fDescription = '';
		fAffinityMode = 'preferred';
		fUserSelectable = false;
		fSelectors = [{ key: '', operator: 'In', values: '' }];
		fTolerations = [];
		modalOpen = true;
	}

	function openEdit(pool: NodePool) {
		editing = pool;
		fName = pool.name;
		fDescription = pool.description ?? '';
		fAffinityMode = pool.affinityMode;
		fUserSelectable = pool.userSelectable;
		fSelectors = (pool.nodeSelector ?? []).map((s) => ({
			key: s.key,
			operator: (s.operator as SelectorExpr['operator']) ?? 'In',
			values: (s.values ?? []).join(', ')
		}));
		if (fSelectors.length === 0) fSelectors = [{ key: '', operator: 'In', values: '' }];
		fTolerations = (pool.tolerations ?? []).map((t) => ({
			key: t.key ?? '',
			operator: (t.operator as TolerationRow['operator']) ?? 'Exists',
			value: t.value ?? '',
			effect: (t.effect as TolerationRow['effect']) ?? ''
		}));
		modalOpen = true;
	}

	function addSelector() {
		fSelectors = [...fSelectors, { key: '', operator: 'In', values: '' }];
	}
	function removeSelector(i: number) {
		fSelectors = fSelectors.filter((_, idx) => idx !== i);
	}
	function addToleration() {
		fTolerations = [
			...fTolerations,
			{ key: '', operator: 'Exists', value: '', effect: 'NoSchedule' }
		];
	}
	function removeToleration(i: number) {
		fTolerations = fTolerations.filter((_, idx) => idx !== i);
	}

	function buildPayload() {
		const nodeSelector = fSelectors
			.filter((s) => s.key.trim())
			.map((s) => {
				const needsValues = s.operator === 'In' || s.operator === 'NotIn';
				return {
					key: s.key.trim(),
					operator: s.operator,
					...(needsValues
						? {
								values: s.values
									.split(',')
									.map((v) => v.trim())
									.filter(Boolean)
							}
						: {})
				};
			});
		const tolerations = fTolerations
			.filter((t) => t.key.trim() || t.operator === 'Exists')
			.map((t) => ({
				...(t.key.trim() ? { key: t.key.trim() } : {}),
				operator: t.operator,
				...(t.operator === 'Equal' && t.value.trim() ? { value: t.value.trim() } : {}),
				...(t.effect ? { effect: t.effect } : {})
			}));
		return {
			name: fName.trim(),
			description: fDescription.trim() || null,
			affinityMode: fAffinityMode,
			userSelectable: fUserSelectable,
			nodeSelector,
			tolerations
		};
	}

	async function save() {
		if (!fName.trim()) {
			toasts.add({ title: 'Enter a name', color: 'error' });
			return;
		}
		saving = true;
		try {
			const payload = buildPayload();
			const url = editing ? `/apiv1/admin/node-pools/${editing.id}` : '/apiv1/admin/node-pools';
			const res = await apiFetch(url, {
				method: editing ? 'PATCH' : 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.message || 'Failed to save pool');
			}
			modalOpen = false;
			await load();
			toasts.add({ title: editing ? 'Pool updated' : 'Pool created', color: 'success' });
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			saving = false;
		}
	}

	async function remove(pool: NodePool) {
		const total = pool._count.deployments + pool._count.jobs + pool._count.databases;
		const note =
			total > 0
				? ` ${total} ${total === 1 ? 'workload goes' : 'workloads go'} back to default scheduling.`
				: '';
		if (!confirm(`Delete pool "${pool.name}"?${note}`)) return;
		try {
			const res = await apiFetch(`/apiv1/admin/node-pools/${pool.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error('Failed to delete');
			await load();
			toasts.add({ title: 'Pool deleted', color: 'success' });
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		}
	}

	onMount(load);
</script>

<div class="mt-10">
	<UserspaceSchedulingToggle />
</div>

<div class="mt-8">
	<div class="flex items-center justify-between mb-3">
		<div class="flex items-center gap-2">
			<Layers class="h-4 w-4 text-muted" />
			<h2 class="text-sm font-semibold text-fg">Node pools</h2>
		</div>
		<Button variant="secondary" size="sm" onclick={openCreate}>
			<Plus class="h-4 w-4" /> New pool
		</Button>
	</div>
	<p class="text-xs text-muted mb-4">
		A pool gives a set of nodes a name. Workloads assigned to the pool run on those nodes.
	</p>

	{#if loading}
		<div class="text-xs text-faint py-6">Loading pools…</div>
	{:else if pools.length === 0}
		<div class="rounded-2xl border border-edge">
			<EmptyState
				title="No node pools yet"
				description="Create one to route workloads onto specific nodes."
			>
				{#snippet icon()}<Layers class="h-10 w-10" />{/snippet}
			</EmptyState>
		</div>
	{:else}
		<div class="space-y-2">
			{#each pools as pool (pool.id)}
				<div class="rounded-xl border border-edge p-3 bg-surface">
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0">
							<div class="flex items-center gap-2 flex-wrap">
								<span class="font-medium text-fg">{pool.name}</span>
								<Badge tone="neutral">{pool.affinityMode}</Badge>
								{#if pool.userSelectable}<Badge tone="success">user-selectable</Badge>{/if}
							</div>
							{#if pool.description}
								<div class="text-xs text-muted mt-1">{pool.description}</div>
							{/if}
							<div class="text-xs text-faint mt-1">
								Selectors: {(pool.nodeSelector ?? []).length} · Tolerations: {(
									pool.tolerations ?? []
								).length} · Workloads: {pool._count.deployments +
									pool._count.jobs +
									pool._count.databases}
							</div>
						</div>
						<div class="flex items-center gap-1 shrink-0">
							<Button
								variant="ghost"
								size="sm"
								onclick={() => openEdit(pool)}
								aria-label="Edit pool"
							>
								<Pencil class="h-4 w-4" />
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onclick={() => remove(pool)}
								aria-label="Delete pool"
							>
								<Trash2 class="h-4 w-4" />
							</Button>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<Modal bind:open={modalOpen} title={editing ? 'Edit node pool' : 'New node pool'} size="lg">
	<div class="space-y-4">
		<Field label="Name" for="pool-name">
			<Input id="pool-name" bind:value={fName} placeholder="Background" class="w-full" />
		</Field>
		<Field label="Description" for="pool-desc">
			<Input
				id="pool-desc"
				bind:value={fDescription}
				placeholder="Older servers for background work"
				class="w-full"
			/>
		</Field>
		<div class="grid grid-cols-2 gap-3">
			<Field label="Affinity" for="pool-mode">
				<Dropdown
					id="pool-mode"
					bind:value={fAffinityMode}
					options={[
						{ value: 'preferred', label: 'preferred (soft)' },
						{ value: 'required', label: 'required (hard)' }
					]}
				/>
			</Field>
			<div class="flex items-end">
				<ToggleRow bind:checked={fUserSelectable} label="User-selectable" />
			</div>
		</div>

		<div>
			<div class="flex items-center justify-between mb-2">
				<span class="text-xs font-semibold text-fg">Node selector</span>
				<Button variant="ghost" size="sm" onclick={addSelector}
					><Plus class="h-3.5 w-3.5" /> Add</Button
				>
			</div>
			{#each fSelectors as sel, i (i)}
				<div class="flex items-center gap-2 mb-2">
					<Input bind:value={sel.key} placeholder="orchard.io/pool" class="flex-1 min-w-0" />
					<div class="w-40 shrink-0">
						<Dropdown
							bind:value={sel.operator}
							options={[
								{ value: 'In', label: 'In' },
								{ value: 'NotIn', label: 'NotIn' },
								{ value: 'Exists', label: 'Exists' },
								{ value: 'DoesNotExist', label: 'DoesNotExist' }
							]}
						/>
					</div>
					<Input
						bind:value={sel.values}
						placeholder="background"
						class="flex-1 min-w-0"
						disabled={sel.operator === 'Exists' || sel.operator === 'DoesNotExist'}
					/>
					<Button variant="ghost" size="sm" onclick={() => removeSelector(i)} aria-label="Remove">
						<X class="h-4 w-4" />
					</Button>
				</div>
			{/each}
			<p class="text-xs text-faint">
				Comma-separate multiple values. Labels are set on nodes under Admin -> Nodes.
			</p>
		</div>

		<div>
			<div class="flex items-center justify-between mb-2">
				<span class="text-xs font-semibold text-fg">Tolerations</span>
				<Button variant="ghost" size="sm" onclick={addToleration}
					><Plus class="h-3.5 w-3.5" /> Add</Button
				>
			</div>
			{#each fTolerations as tol, i (i)}
				<div class="flex items-center gap-2 mb-2">
					<Input bind:value={tol.key} placeholder="orchard.io/pool" class="flex-1 min-w-0" />
					<div class="w-28 shrink-0">
						<Dropdown
							bind:value={tol.operator}
							options={[
								{ value: 'Exists', label: 'Exists' },
								{ value: 'Equal', label: 'Equal' }
							]}
						/>
					</div>
					<Input
						bind:value={tol.value}
						placeholder="background"
						class="flex-1 min-w-0"
						disabled={tol.operator !== 'Equal'}
					/>
					<div class="w-48 shrink-0">
						<Dropdown
							bind:value={tol.effect}
							options={[
								{ value: '', label: 'Any effect' },
								{ value: 'NoSchedule', label: 'NoSchedule' },
								{ value: 'PreferNoSchedule', label: 'PreferNoSchedule' },
								{ value: 'NoExecute', label: 'NoExecute' }
							]}
						/>
					</div>
					<Button variant="ghost" size="sm" onclick={() => removeToleration(i)} aria-label="Remove">
						<X class="h-4 w-4" />
					</Button>
				</div>
			{/each}
			<p class="text-xs text-faint">
				A toleration lets workloads in this pool run on a matching tainted node.
			</p>
		</div>
	</div>

	{#snippet footer()}
		<Button variant="ghost" onclick={() => (modalOpen = false)}>Cancel</Button>
		<Button variant="primary" loading={saving} onclick={save}>
			{editing ? 'Save pool' : 'Create pool'}
		</Button>
	{/snippet}
</Modal>
