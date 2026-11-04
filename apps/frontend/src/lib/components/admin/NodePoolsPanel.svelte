<script lang="ts">
	import { onMount } from 'svelte';
	import { Layers, Pencil, Plus, Trash2 } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		Alert,
		Badge,
		Button,
		Dropdown,
		EmptyState,
		Field,
		FieldGrid,
		Input,
		List,
		ListRow,
		Modal,
		RowList,
		SectionCard,
		SectionTitle,
		SegmentedControl,
		Skeleton,
		Stack,
		Swap,
		ToggleRow
	} from '$lib/components/ui';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import UserspaceSchedulingToggle from './UserspaceSchedulingToggle.svelte';

	interface SelectorExpr {
		id: number;
		key: string;
		operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';
		values: string;
	}
	interface TolerationRow {
		id: number;
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

	const AFFINITY_MODES = [
		{ value: 'preferred', label: 'Preferred (soft)' },
		{ value: 'required', label: 'Required (hard)' }
	];
	const SELECTOR_OPERATORS = ['In', 'NotIn', 'Exists', 'DoesNotExist'].map((v) => ({
		value: v,
		label: v
	}));
	const TOLERATION_OPERATORS = ['Exists', 'Equal'].map((v) => ({ value: v, label: v }));
	const TOLERATION_EFFECTS = [
		{ value: '', label: 'Any effect' },
		{ value: 'NoSchedule', label: 'NoSchedule' },
		{ value: 'PreferNoSchedule', label: 'PreferNoSchedule' },
		{ value: 'NoExecute', label: 'NoExecute' }
	];

	let pools = $state<NodePool[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let editing = $state<NodePool | null>(null);
	let modalOpen = $state(false);
	let saving = $state(false);
	let removing = $state<NodePool | null>(null);
	let removeOpen = $state(false);

	let fName = $state('');
	let fDescription = $state('');
	let fAffinityMode = $state<'required' | 'preferred'>('preferred');
	let fUserSelectable = $state(false);
	let fSelectors = $state<SelectorExpr[]>([]);
	let fTolerations = $state<TolerationRow[]>([]);

	let nextRowId = 0;

	const view = $derived(
		loading ? 'loading' : loadError ? 'error' : pools.length === 0 ? 'empty' : 'rows'
	);

	const removeSummary = $derived.by(() => {
		if (!removing) return '';
		const total = workloads(removing);
		if (total === 0) return 'No workloads use this pool.';
		return `${total} ${total === 1 ? 'workload goes' : 'workloads go'} back to default scheduling.`;
	});

	function workloads(pool: NodePool) {
		return pool._count.deployments + pool._count.jobs + pool._count.databases;
	}

	function plural(n: number, one: string, many = `${one}s`) {
		return `${n} ${n === 1 ? one : many}`;
	}

	function poolDetail(pool: NodePool) {
		const counts = [
			plural((pool.nodeSelector ?? []).length, 'selector'),
			plural((pool.tolerations ?? []).length, 'toleration'),
			plural(workloads(pool), 'workload')
		].join(' · ');
		return pool.description ? `${pool.description} · ${counts}` : counts;
	}

	function blankSelector(): SelectorExpr {
		return { id: ++nextRowId, key: '', operator: 'In', values: '' };
	}

	async function load() {
		loading = true;
		loadError = null;
		try {
			const res = await apiFetch('/apiv1/admin/node-pools');
			if (!res.ok) throw new Error(`The server answered ${res.status}.`);
			pools = await res.json();
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'Request failed';
		} finally {
			loading = false;
		}
	}

	async function reload() {
		try {
			const res = await apiFetch('/apiv1/admin/node-pools');
			if (!res.ok) throw new Error("Couldn't load node pools");
			pools = await res.json();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		}
	}

	function openCreate() {
		editing = null;
		fName = '';
		fDescription = '';
		fAffinityMode = 'preferred';
		fUserSelectable = false;
		fSelectors = [blankSelector()];
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
			id: ++nextRowId,
			key: s.key,
			operator: (s.operator as SelectorExpr['operator']) ?? 'In',
			values: (s.values ?? []).join(', ')
		}));
		if (fSelectors.length === 0) fSelectors = [blankSelector()];
		fTolerations = (pool.tolerations ?? []).map((t) => ({
			id: ++nextRowId,
			key: t.key ?? '',
			operator: (t.operator as TolerationRow['operator']) ?? 'Exists',
			value: t.value ?? '',
			effect: (t.effect as TolerationRow['effect']) ?? ''
		}));
		modalOpen = true;
	}

	function addSelector() {
		fSelectors = [...fSelectors, blankSelector()];
	}
	function removeSelector(i: number) {
		fSelectors = fSelectors.filter((_, idx) => idx !== i);
	}
	function addToleration() {
		fTolerations = [
			...fTolerations,
			{ id: ++nextRowId, key: '', operator: 'Exists', value: '', effect: 'NoSchedule' }
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
		if (!fName.trim()) return;
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
				throw new Error(err.message || "Couldn't save pool");
			}
			modalOpen = false;
			await reload();
			toasts.add({ title: editing ? 'Pool updated' : 'Pool created', color: 'success' });
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			saving = false;
		}
	}

	function askRemove(pool: NodePool) {
		removing = pool;
		removeOpen = true;
	}

	async function remove() {
		if (!removing) return;
		try {
			const res = await apiFetch(`/apiv1/admin/node-pools/${removing.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error("Couldn't delete");
			await reload();
			toasts.add({ title: 'Pool deleted', color: 'success' });
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		}
	}

	onMount(load);
</script>

<UserspaceSchedulingToggle />

<SectionCard
	title="Node pools"
	description="A pool names a set of nodes. Workloads assigned to it run on those nodes."
>
	{#snippet actions()}
		{#if view === 'rows' || view === 'loading'}
			<Button size="sm" icon={Plus} disabled={loading} onclick={openCreate}>New pool</Button>
		{/if}
	{/snippet}

	<Swap key={view}>
		{#if view === 'loading'}
			<Stack gap="xs">
				<Skeleton height="3.25rem" />
				<Skeleton height="3.25rem" />
			</Stack>
		{:else if view === 'error'}
			<Alert tone="error" title="Couldn't load node pools">
				{loadError}
				{#snippet actions()}
					<Button size="sm" onclick={load}>Retry</Button>
				{/snippet}
			</Alert>
		{:else if view === 'empty'}
			<EmptyState title="No node pools yet">
				{#snippet icon()}<Layers size={20} />{/snippet}
				<Button icon={Plus} onclick={openCreate}>New pool</Button>
			</EmptyState>
		{:else}
			<List inset={false} label="Node pools">
				{#each pools as pool (pool.id)}
					<ListRow flush pinned presence title={pool.name} subtitle={poolDetail(pool)}>
						{#snippet titleSuffix()}
							<Badge>{pool.affinityMode === 'required' ? 'Required' : 'Preferred'}</Badge>
							{#if pool.userSelectable}<Badge>User-selectable</Badge>{/if}
						{/snippet}
						{#snippet actions()}
							<Button
								variant="ghost"
								size="sm"
								icon={Pencil}
								label="Edit {pool.name}"
								onclick={() => openEdit(pool)}
							/>
							<Button
								variant="ghost"
								size="sm"
								icon={Trash2}
								label="Delete {pool.name}"
								onclick={() => askRemove(pool)}
							/>
						{/snippet}
					</ListRow>
				{/each}
			</List>
		{/if}
	</Swap>
</SectionCard>

<Modal bind:open={modalOpen} title={editing ? 'Edit node pool' : 'New node pool'} size="xl">
	<div class="form">
		<FieldGrid>
			<Field label="Name" for="pool-name">
				<Input id="pool-name" bind:value={fName} placeholder="Background" />
			</Field>
			<Field label="Description" for="pool-desc">
				<Input
					id="pool-desc"
					bind:value={fDescription}
					placeholder="Older servers for background work"
				/>
			</Field>
		</FieldGrid>
		<Field label="Affinity">
			<SegmentedControl
				label="Affinity"
				options={AFFINITY_MODES}
				grow
				bind:value={() => fAffinityMode, (v) => (fAffinityMode = v as 'required' | 'preferred')}
			/>
		</Field>
		<ToggleRow
			bind:checked={fUserSelectable}
			label="User-selectable"
			hint="People can assign workloads to this pool when userspace scheduling is on."
		/>

		<Stack gap="sm">
			<div class="group-head">
				<SectionTitle title="Node selector" size="md" />
				<p class="hint">Comma-separate multiple values. Set labels by opening a node above.</p>
			</div>
			<RowList
				label="Node selector"
				items={fSelectors}
				key={(sel) => sel.id}
				columns={[{ label: 'Key' }, { label: 'Operator', width: '9.5rem' }, { label: 'Values' }]}
				addLabel="Add selector"
				onadd={addSelector}
				onremove={removeSelector}
				removeLabel={(sel) => `Remove ${sel.key || 'selector'}`}
			>
				{#snippet row(sel)}
					<Input bind:value={sel.key} mono placeholder="orchard.io/pool" aria-label="Key" />
					<Dropdown bind:value={sel.operator} options={SELECTOR_OPERATORS} ariaLabel="Operator" />
					<Input
						bind:value={sel.values}
						mono
						placeholder="background"
						aria-label="Values"
						disabled={sel.operator === 'Exists' || sel.operator === 'DoesNotExist'}
					/>
				{/snippet}
			</RowList>
		</Stack>

		<Stack gap="sm">
			<div class="group-head">
				<SectionTitle title="Tolerations" size="md" />
				<p class="hint">A toleration lets workloads in this pool run on a matching tainted node.</p>
			</div>
			<RowList
				label="Tolerations"
				items={fTolerations}
				key={(tol) => tol.id}
				columns={[
					{ label: 'Key' },
					{ label: 'Operator', width: '6.5rem' },
					{ label: 'Value' },
					{ label: 'Effect', width: '11rem' }
				]}
				addLabel="Add toleration"
				onadd={addToleration}
				onremove={removeToleration}
				removeLabel={(tol) => `Remove ${tol.key || 'toleration'}`}
			>
				{#snippet row(tol)}
					<Input bind:value={tol.key} mono placeholder="orchard.io/pool" aria-label="Key" />
					<Dropdown bind:value={tol.operator} options={TOLERATION_OPERATORS} ariaLabel="Operator" />
					<Input
						bind:value={tol.value}
						mono
						placeholder="background"
						aria-label="Value"
						disabled={tol.operator !== 'Equal'}
					/>
					<Dropdown bind:value={tol.effect} options={TOLERATION_EFFECTS} ariaLabel="Effect" />
				{/snippet}
			</RowList>
		</Stack>
	</div>

	{#snippet footer()}
		<Button variant="ghost" onclick={() => (modalOpen = false)}>Cancel</Button>
		<Button variant="primary" loading={saving} disabled={!fName.trim()} onclick={save}>
			{editing ? 'Save pool' : 'Create pool'}
		</Button>
	{/snippet}
</Modal>

<ConfirmModal
	bind:open={removeOpen}
	title="Delete the {removing?.name ?? ''} pool?"
	description={removeSummary}
	confirmLabel="Delete"
	onconfirm={remove}
	oncancel={() => undefined}
/>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.group-head {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		margin-top: var(--space-2);
	}
	.hint {
		color: var(--text-muted);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
	}
</style>
