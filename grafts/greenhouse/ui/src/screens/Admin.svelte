<script lang="ts">
	import { ChevronLeft, ChevronRight, Pencil, Search } from 'lucide-svelte';
	import {
		Avatar,
		Button,
		EmptyState,
		Field,
		Input,
		Modal,
		PageHeader,
		Skeleton
	} from '@orchardlabs/graft-ui';
	import { isSuperAdmin, toasts } from '../host/stores';
	import { useHost } from '../host/context';

	interface LimitRow {
		id: string;
		username: string;
		email: string;
		imageUrl: string | null;
		maxSandboxes: number | null;
	}

	const PAGE_SIZE = 20;

	let rows = $state<LimitRow[]>([]);
	let total = $state(0);
	let page = $state(1);
	let loading = $state(true);
	let failed = $state<string | null>(null);
	let search = $state('');
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let requestId = 0;

	let editing = $state<LimitRow | null>(null);
	let limit = $state('');
	let saving = $state(false);

	const pages = $derived(Math.max(1, Math.ceil(total / PAGE_SIZE)));
	const limitError = $derived(parseLimit(limit) === undefined ? 'Use a whole number from 0 to 100' : null);

	function parseLimit(value: unknown): number | null | undefined {
		const trimmed = String(value ?? '').trim();
		if (!trimmed) return null;
		if (!/^\d+$/.test(trimmed)) return undefined;
		const n = Number(trimmed);
		return n >= 0 && n <= 100 ? n : undefined;
	}

	async function load(target = page) {
		const id = ++requestId;
		loading = true;
		failed = null;
		try {
			const params = new URLSearchParams({ page: String(target) });
			if (search.trim()) params.set('search', search.trim());
			const data = await useHost().api<{ users: LimitRow[]; total: number }>(
				`/apiv1/greenhouse/admin/limits?${params}`
			);
			if (id !== requestId) return;
			rows = data.users ?? [];
			total = data.total ?? rows.length;
			page = target;
		} catch (e) {
			if (id !== requestId) return;
			failed = e instanceof Error ? e.message : "Couldn't load sandbox limits";
		} finally {
			if (id === requestId) loading = false;
		}
	}

	$effect(() => {
		if ($isSuperAdmin) void load(1);
	});

	function onSearch() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			void load(1);
		}, 300);
	}

	function openEdit(row: LimitRow) {
		editing = row;
		limit = row.maxSandboxes === null ? '' : String(row.maxSandboxes);
	}

	async function save() {
		const row = editing;
		const value = parseLimit(limit);
		if (!row || value === undefined) return;
		saving = true;
		try {
			await useHost().api(`/apiv1/greenhouse/admin/limits/${encodeURIComponent(row.id)}`, {
				method: 'PUT',
				json: { maxSandboxes: value }
			});
			rows = rows.map((r) => (r.id === row.id ? { ...r, maxSandboxes: value } : r));
			toasts.add({ title: `Updated ${row.username || row.email}`, color: 'success' });
			editing = null;
		} catch (e) {
			toasts.add({
				title: "Couldn't update the limit",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}
</script>

<div class="gh-admin">
	<PageHeader title="Greenhouse">
		{#snippet meta()}
			<span class="gh-admin-sub">How many sandboxes each person may keep at once.</span>
		{/snippet}
	</PageHeader>

	{#if !$isSuperAdmin}
		<EmptyState title="Instance admins only" description="Ask an instance admin to change sandbox limits." />
	{:else}
		<div class="gh-admin-bar">
			<div class="gh-admin-search">
				<span class="gh-admin-search-icon"><Search size={14} /></span>
				<Input
					type="search"
					bind:value={search}
					oninput={onSearch}
					placeholder="Search by name, email or username"
					aria-label="Search people"
				/>
			</div>
			<span class="gh-admin-total">{total} {total === 1 ? 'person' : 'people'}</span>
		</div>

		<div class="gh-admin-list" aria-busy={loading}>
			{#if loading && rows.length === 0}
				{#each { length: 6 } as _, i (i)}
					<div class="gh-admin-row"><Skeleton height="2rem" /></div>
				{/each}
			{:else if failed}
				<EmptyState title="Couldn't load sandbox limits" description={failed}>
					<Button size="sm" onclick={() => load(page)}>Try again</Button>
				</EmptyState>
			{:else if rows.length === 0}
				<EmptyState title="Nobody matches" description="Try a different name or email." />
			{:else}
				{#each rows as row (row.id)}
					<div class="gh-admin-row">
						<Avatar user={row} size={28} alt="" />
						<div class="gh-admin-who">
							<span class="gh-admin-name">{row.username || row.email}</span>
							<span class="gh-admin-email">{row.email}</span>
						</div>
						<span class="gh-admin-limit" class:gh-admin-limit--default={row.maxSandboxes === null}>
							{row.maxSandboxes === null
								? 'Server default'
								: `${row.maxSandboxes} sandbox${row.maxSandboxes === 1 ? '' : 'es'}`}
						</span>
						<Button
							variant="ghost"
							size="sm"
							onclick={() => openEdit(row)}
							aria-label={`Edit the sandbox limit for ${row.username || row.email}`}
						>
							<Pencil size={14} />
						</Button>
					</div>
				{/each}
			{/if}
		</div>

		{#if pages > 1}
			<div class="gh-admin-pages">
				<Button
					variant="ghost"
					size="sm"
					disabled={page <= 1 || loading}
					onclick={() => load(page - 1)}
					aria-label="Previous page"
				>
					<ChevronLeft size={14} />
				</Button>
				<span>Page {page} of {pages}</span>
				<Button
					variant="ghost"
					size="sm"
					disabled={page >= pages || loading}
					onclick={() => load(page + 1)}
					aria-label="Next page"
				>
					<ChevronRight size={14} />
				</Button>
			</div>
		{/if}
	{/if}
</div>

<Modal
	bind:open={
		() => editing !== null,
		(v) => {
			if (!v) editing = null;
		}
	}
	title="Sandbox limit"
	size="sm"
>
	{#if editing}
		<form
			class="gh-admin-form"
			onsubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<p class="gh-admin-form-who">{editing.username || editing.email}</p>
			<Field
				label="Max sandboxes"
				hint="Leave empty to use the server default"
				error={limitError}
				for="gh-admin-limit"
			>
				<Input
					id="gh-admin-limit"
					type="number"
					min="0"
					max="100"
					bind:value={limit}
					placeholder="Default"
					error={!!limitError}
				/>
			</Field>
		</form>
	{/if}
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (editing = null)}>Cancel</Button>
		<Button variant="primary" loading={saving} disabled={!!limitError} onclick={save}>Save</Button>
	{/snippet}
</Modal>

<style>
	.gh-admin {
		display: flex;
		flex-direction: column;
		gap: var(--space-4, 1rem);
		padding: 1.75rem;
		max-width: 52rem;
	}

	.gh-admin-sub,
	.gh-admin-total,
	.gh-admin-email,
	.gh-admin-pages {
		color: var(--text-muted);
		font-size: var(--text-footnote, 0.8125rem);
	}

	.gh-admin-bar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.gh-admin-search {
		position: relative;
		flex: 1;
		min-width: 0;
	}

	.gh-admin-search :global(input) {
		width: 100%;
		padding-left: 2rem;
	}

	.gh-admin-search-icon {
		position: absolute;
		left: 0.625rem;
		top: 50%;
		transform: translateY(-50%);
		display: inline-flex;
		color: var(--text-faint);
		pointer-events: none;
	}

	.gh-admin-total {
		white-space: nowrap;
	}

	.gh-admin-list {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md, 0.5rem);
		background: var(--bg-surface);
		overflow: hidden;
	}

	.gh-admin-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.625rem 0.875rem;
	}

	.gh-admin-row + .gh-admin-row {
		border-top: 1px solid var(--border-default);
	}

	.gh-admin-who {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}

	.gh-admin-name {
		color: var(--text-default);
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.gh-admin-email {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.gh-admin-limit {
		color: var(--text-default);
		font-size: var(--text-footnote, 0.8125rem);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.gh-admin-limit--default {
		color: var(--text-faint);
	}

	.gh-admin-pages {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
	}

	.gh-admin-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.gh-admin-form-who {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--text-footnote, 0.8125rem);
	}
</style>
