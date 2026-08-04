<script lang="ts">
	import { EllipsisVertical, Play, Square, Trash2 } from 'lucide-svelte';
	import { Button, Menu, MenuItem, StatusDot, Table, sandboxStatus } from '$lib/components/ui';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { timeAgo } from '$lib/components/org-dashboard/helpers.svelte';
	import type { Sandbox } from '$lib/types/sandbox';

	let {
		sandboxes,
		busyId = null,
		onstart,
		onstop,
		ondelete
	}: {
		sandboxes: Sandbox[];
		busyId?: string | null;
		onstart: (sandbox: Sandbox) => void;
		onstop: (sandbox: Sandbox) => void;
		ondelete: (sandbox: Sandbox) => void;
	} = $props();

	let deleteTarget = $state<Sandbox | null>(null);
	let deleteOpen = $state(false);

	const columns = [
		{ id: 'name', label: 'Name' },
		{ id: 'status', label: 'Status', width: '9rem' },
		{ id: 'created', label: 'Created', width: '7rem' },
		{ id: 'active', label: 'Last active', width: '7rem' },
		{ id: 'actions', width: '6rem', align: 'end' as const }
	];

	function repoLabel(url: string): string {
		return url.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '');
	}
</script>

<Table {columns} rows={sandboxes} rowKey={(s) => s.id}>
	{#snippet row(s)}
		<span class="sbx-name-cell">
			<span class="sbx-name">{s.name}</span>
			{#if s.repoUrl}
				<span class="sbx-repo">{repoLabel(s.repoUrl)}</span>
			{/if}
		</span>
		<span class="sbx-status" title={s.statusMessage ?? undefined}>
			<StatusDot meta={sandboxStatus(s.status)} size={7} />
			{sandboxStatus(s.status).label}
		</span>
		<span class="sbx-when">{timeAgo(s.createdAt)}</span>
		<span class="sbx-when">{s.lastActiveAt ? timeAgo(s.lastActiveAt) : 'Never'}</span>
		<span class="sbx-actions">
			{#if s.status === 'stopped' || s.status === 'error'}
				<Button size="sm" variant="ghost" loading={busyId === s.id} onclick={() => onstart(s)}>
					<Play class="h-3.5 w-3.5" /> Start
				</Button>
			{:else if s.status === 'running'}
				<Button size="sm" variant="ghost" loading={busyId === s.id} onclick={() => onstop(s)}>
					<Square class="h-3.5 w-3.5" /> Stop
				</Button>
			{/if}
			<Menu>
				{#snippet trigger(attrs)}
					<Button size="sm" variant="ghost" aria-label="Sandbox actions" {...attrs}>
						<EllipsisVertical class="h-4 w-4" />
					</Button>
				{/snippet}
				<MenuItem
					danger
					onclick={() => {
						deleteTarget = s;
						deleteOpen = true;
					}}
				>
					<Trash2 size={14} /> Delete
				</MenuItem>
			</Menu>
		</span>
	{/snippet}
</Table>

<ConfirmModal
	bind:open={deleteOpen}
	title="Delete sandbox?"
	description={`This permanently deletes ${deleteTarget?.name ?? 'this sandbox'} and its home volume. Anything not pushed to a remote is gone.`}
	confirmLabel="Delete"
	onconfirm={() => {
		if (deleteTarget) ondelete(deleteTarget);
	}}
	oncancel={() => {}}
/>

<style>
	.sbx-name-cell {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.sbx-name {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		color: var(--text-default);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sbx-repo {
		font-family: var(--font-mono, monospace);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sbx-status {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
		white-space: nowrap;
	}

	.sbx-when {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		white-space: nowrap;
	}

	.sbx-actions {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.25rem;
	}
</style>
