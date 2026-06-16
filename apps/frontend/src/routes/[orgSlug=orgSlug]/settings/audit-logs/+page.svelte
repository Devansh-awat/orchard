<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { apiFetch, toasts } from '$lib/stores';
	import AuditLogList from '$lib/components/AuditLogList.svelte';
	import { Loader2 } from 'lucide-svelte';

	let organizationId = $state<string | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	const orgSlug = $derived($page.params.orgSlug);

	async function load() {
		loading = true;
		try {
			const res = await apiFetch(`/apiv1/organizations/slug/${orgSlug}`);
			if (!res.ok) throw new Error('Organization not found');
			const data = await res.json();
			organizationId = data.id;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load organization';
			toasts.add({ title: 'Error', description: error, color: 'error' });
		} finally {
			loading = false;
		}
	}

	onMount(load);
</script>

<div class="p-6">
	<div class="mb-4">
		<h1 class="text-2xl font-bold" style="color: var(--center-channel-color);">Audit Log</h1>
		<p class="text-sm" style="color: var(--surface-muted);">
			Recent activity across this organization. Visible to org owners and admins.
		</p>
	</div>

	{#if loading}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="h-5 w-5 animate-spin" style="color: var(--surface-muted);" />
		</div>
	{:else if error}
		<div
			class="rounded-lg border p-4 text-sm"
			style="border-color: var(--surface-border); color: var(--surface-muted);"
		>
			{error}
		</div>
	{:else if organizationId}
		<AuditLogList scope={{ organizationId }} title="Organization activity" />
	{/if}
</div>
