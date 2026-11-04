<script lang="ts">
	import { goto } from '$app/navigation';
	import { ArchiveRestore } from 'lucide-svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { Button, List, ListRow, SectionTitle } from '$lib/components/ui';
	import RelativeTime from '$lib/components/ui/RelativeTime.svelte';
	import ResourceTile from '$lib/components/patterns/ResourceTile.svelte';
	import { statusMeta } from '$lib/components/ui/status';
	import { errorMessage } from './recovery';
	import type { DatabaseOperation, DeletedDatabase } from './types';

	let {
		projectId,
		orgSlug,
		matches = () => true,
		canEdit = true,
		onrestored = undefined
	}: {
		projectId: string;
		orgSlug: string;
		matches?: (row: { environmentId?: string | null }) => boolean;
		canEdit?: boolean;
		onrestored?: () => void;
	} = $props();

	let rows = $state<DeletedDatabase[]>([]);
	let busy = $state<string | null>(null);

	const visible = $derived(rows.filter(matches));

	async function load(id: string) {
		try {
			const res = await apiFetch(`/apiv1/projects/${id}/deleted-databases`);
			if (!res.ok || id !== projectId) return;
			rows = await res.json();
		} catch {
			return;
		}
	}

	$effect(() => {
		const id = projectId;
		if (id) void load(id);
	});

	const day = (iso: string) =>
		new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

	function why(row: DeletedDatabase) {
		if (row.reason === 'environment') return 'Deleted with its environment';
		if (row.reason === 'project') return 'Deleted with the project';
		return 'Deleted';
	}

	async function bringBack(row: DeletedDatabase) {
		busy = row.id;
		try {
			const res = await apiFetch(`/apiv1/deleted-databases/${row.id}/restore`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({})
			});
			if (!res.ok) throw new Error(await errorMessage(res, "Couldn't bring it back"));
			const op = (await res.json()) as DatabaseOperation;
			rows = rows.filter((r) => r.id !== row.id);
			toasts.add({
				title: `Bringing back ${row.name}`,
				description: 'It restores from its last backup and archived WAL.',
				color: 'success',
				action: op.targetDatabaseId
					? { label: 'Open', onClick: () => goto(`/${orgSlug}/databases/${op.targetDatabaseId}`) }
					: undefined
			});
			onrestored?.();
		} catch (e) {
			toasts.add({
				title: "Couldn't bring it back",
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			busy = null;
		}
	}
</script>

{#if visible.length > 0}
	<section class="deleted" aria-label="Recently deleted">
		<SectionTitle title="Recently deleted" size="md" count={visible.length} />
		<List label="Recently deleted databases">
			{#each visible as row (row.id)}
				<ListRow presence pinned title={row.name}>
					{#snippet leading()}
						<span class="tile">
							<ResourceTile kind="database" status={statusMeta('neutral', 'Deleted')} />
						</span>
					{/snippet}
					{#snippet subtitle()}
						<span>{why(row)} <RelativeTime date={row.deletedAt} /></span>
						<span class="sep" aria-hidden="true">·</span>
						{#if row.recoverableUntil}
							<span>can be brought back until {day(row.purgeAfter)}</span>
						{:else}
							<span>never backed up, so it can't be brought back</span>
						{/if}
					{/snippet}
					{#snippet actions()}
						{#if row.recoverableUntil && canEdit}
							<Button
								size="sm"
								icon={ArchiveRestore}
								loading={busy === row.id}
								disabled={!!busy && busy !== row.id}
								onclick={() => bringBack(row)}
							>
								Bring back
							</Button>
						{/if}
					{/snippet}
				</ListRow>
			{/each}
		</List>
	</section>
{/if}

<style>
	.deleted {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-width: 0;
		margin-top: var(--space-4);
	}
	.tile {
		display: contents;
		color: var(--text-faint);
	}
	.sep {
		color: var(--text-faint);
	}
</style>
