<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts, isSuperAdmin } from '$lib/stores';
	import { SectionCard, Dropdown } from '$lib/components/ui';
	import SettingsList from '$lib/components/ui/SettingsList.svelte';
	import SettingRow from '$lib/components/ui/SettingRow.svelte';

	let {
		deploymentId,
		nodePoolId = null,
		onSaved
	}: {
		deploymentId: string;
		nodePoolId?: string | null;
		onSaved?: (updated: Record<string, unknown>) => void;
	} = $props();

	interface PoolOption {
		id: string;
		name: string;
		slug: string;
		description: string | null;
	}

	const uid = $props.id();

	let pools = $state<PoolOption[]>([]);
	let selected = $state<string>(nodePoolId ?? '');
	let saving = $state(false);
	let loaded = $state(false);

	async function load() {
		try {
			const url = $isSuperAdmin ? '/apiv1/admin/node-pools' : '/apiv1/node-pools';
			const res = await apiFetch(url);
			if (!res.ok) return;
			const data = await res.json();
			pools = Array.isArray(data) ? data : [];
		} catch {
			pools = [];
		} finally {
			loaded = true;
		}
	}

	async function save(next: string) {
		const previous = selected;
		selected = next;
		saving = true;
		try {
			const res = await apiFetch(`/apiv1/deployments/${deploymentId}/placement`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ nodePoolId: next || null })
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.message || "Couldn't update pool");
			}
			const updated = await res.json().catch(() => null);
			if (updated) onSaved?.(updated);
			toasts.add({
				title: 'Node pool saved',
				description: 'Applies on the next deploy.',
				color: 'success'
			});
		} catch (e) {
			selected = previous;
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			saving = false;
		}
	}

	onMount(load);
</script>

{#if loaded && pools.length > 0}
	<SectionCard title="Placement">
		<SettingsList>
			<SettingRow label="Node pool" hint="Applies on the next deploy" for="{uid}-pool">
				<div class="np-picker">
					<Dropdown
						id="{uid}-pool"
						disabled={saving}
						bind:value={() => selected, save}
						options={[
							{ value: '', label: 'Default' },
							...pools.map((pool) => ({ value: pool.id, label: pool.name }))
						]}
					/>
				</div>
			</SettingRow>
		</SettingsList>
	</SectionCard>
{/if}

<style>
	.np-picker {
		width: 15rem;
		min-width: 0;
	}
</style>
