<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { Alert, Button, SectionCard, Skeleton, Swap, ToggleRow } from '$lib/components/ui';

	interface Setting {
		enabled: boolean;
		dbValue: boolean;
		envOverride: boolean | null;
	}

	const HINT = 'Users can assign workloads to any user-selectable pool. Off, only superadmins can.';

	let setting = $state<Setting | null>(null);
	let loading = $state(true);
	let saving = false;

	async function load() {
		loading = true;
		try {
			const res = await apiFetch('/apiv1/admin/instance-settings/userspace-scheduling');
			if (res.ok) setting = await res.json();
		} catch {
			setting = null;
		} finally {
			loading = false;
		}
	}

	async function apply(next: boolean) {
		if (!setting || setting.envOverride !== null || saving) return;
		const previous = setting;
		saving = true;
		setting = { ...setting, dbValue: next };
		try {
			const res = await apiFetch('/apiv1/admin/instance-settings/userspace-scheduling', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: next })
			});
			if (!res.ok) throw new Error("Couldn't save");
			setting = await res.json();
			toasts.add({
				title: next ? 'Userspace scheduling on' : 'Userspace scheduling off',
				color: 'success'
			});
		} catch (e) {
			setting = previous;
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			saving = false;
		}
	}

	onMount(load);
</script>

<SectionCard title="Userspace scheduling">
	<Swap key={loading ? 'loading' : setting ? 'setting' : 'error'}>
		{#if loading}
			<Skeleton height="2.5rem" />
		{:else if !setting}
			<Alert tone="error" title="Couldn't load this setting">
				{#snippet actions()}
					<Button size="sm" onclick={load}>Retry</Button>
				{/snippet}
			</Alert>
		{:else if setting.envOverride !== null}
			<ToggleRow
				checked={setting.envOverride}
				label="Let users pick a node pool"
				hint="Pinned by USERSPACE_NODE_SCHEDULING. Unset it to control this here."
				disabled
			/>
		{:else}
			<ToggleRow
				bind:checked={() => setting?.dbValue ?? false, (v) => void apply(v)}
				label="Let users pick a node pool"
				hint={HINT}
			/>
		{/if}
	</Swap>
</SectionCard>
