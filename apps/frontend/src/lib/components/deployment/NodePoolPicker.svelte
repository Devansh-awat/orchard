<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts, isSuperAdmin } from '$lib/stores';
	import { SectionCard, Select, Button } from '$lib/components/ui';

	let { deploymentId, nodePoolId = null }: { deploymentId: string; nodePoolId?: string | null } =
		$props();

	interface PoolOption {
		id: string;
		name: string;
		slug: string;
		description: string | null;
	}

	let pools = $state<PoolOption[]>([]);
	let selected = $state<string>(nodePoolId ?? '');
	let saving = $state(false);
	let loaded = $state(false);

	async function load() {
		try {
			// Superadmins pick from every pool; tenants only see user-selectable ones.
			const url = $isSuperAdmin ? '/apiv1/admin/node-pools' : '/apiv1/node-pools';
			const res = await apiFetch(url);
			if (!res.ok) return;
			pools = await res.json();
		} catch {
			// Feature off or unreachable — leave the picker empty; it just won't render.
		} finally {
			loaded = true;
		}
	}

	async function save() {
		saving = true;
		try {
			const res = await apiFetch(`/apiv1/deployments/${deploymentId}/placement`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ nodePoolId: selected || null })
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.message || 'Failed to update pool');
			}
			toasts.add({ title: 'Node pool saved. Redeploy to apply.', color: 'success' });
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			saving = false;
		}
	}

	const dirty = $derived((selected || '') !== (nodePoolId || ''));

	onMount(load);
</script>

{#if loaded && pools.length > 0}
	<SectionCard title="Node pool">
		{#snippet actions()}
			<Button size="sm" loading={saving} disabled={!dirty} onclick={save}>Save</Button>
		{/snippet}
		<p class="text-xs text-muted mb-2">
			Route this app onto a specific set of nodes. Takes effect on the next deploy.
		</p>
		<Select bind:value={selected} class="w-full">
			<option value="">Default (no pool)</option>
			{#each pools as pool (pool.id)}
				<option value={pool.id}>{pool.name}</option>
			{/each}
		</Select>
	</SectionCard>
{/if}
