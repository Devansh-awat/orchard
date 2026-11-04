<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { SectionCard, ToggleRow, Badge } from '$lib/components/ui';

	interface State {
		enabled: boolean;
		dbValue: boolean;
		envOverride: boolean | null;
	}

	let state = $state<State | null>(null);
	let saving = $state(false);

	async function load() {
		try {
			const res = await apiFetch('/apiv1/admin/instance-settings/userspace-scheduling');
			if (!res.ok) return;
			state = await res.json();
		} catch {
			// leave null; card just won't show a value
		}
	}

	async function toggle() {
		if (!state || state.envOverride !== null) return;
		saving = true;
		const next = !state.dbValue;
		try {
			const res = await apiFetch('/apiv1/admin/instance-settings/userspace-scheduling', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: next })
			});
			if (!res.ok) throw new Error("Couldn't save");
			state = await res.json();
			toasts.add({
				title: next ? 'Userspace scheduling on' : 'Userspace scheduling off',
				color: 'success'
			});
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			saving = false;
		}
	}

	onMount(load);
</script>

{#if state}
	<SectionCard title="Userspace scheduling">
		<p class="text-xs text-muted mb-3">
			When on, users can assign their workloads to any pool marked user-selectable. When off, only
			superadmins can. Only superadmins can change pool taints and labels.
		</p>
		{#if state.envOverride !== null}
			<div class="flex items-center gap-2 text-xs text-muted">
				<Badge tone="neutral">env override</Badge>
				<span>
					Pinned to <span class="font-mono">{state.envOverride ? 'on' : 'off'}</span> by the
					<span class="font-mono">USERSPACE_NODE_SCHEDULING</span> environment variable. Unset it to control
					this here.
				</span>
			</div>
		{:else}
			<ToggleRow
				checked={state.dbValue}
				label="Let users pick a node pool"
				disabled={saving}
				onchange={toggle}
			/>
		{/if}
	</SectionCard>
{/if}
