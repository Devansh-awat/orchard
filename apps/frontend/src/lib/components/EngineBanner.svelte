<script lang="ts">
	import { page } from '$app/stores';
	import Alert from '$lib/components/ui/Alert.svelte';
	import { selectedOrganization } from '$lib/stores';
	import { engineHealth } from '$lib/stores/engineHealth';

	const health = engineHealth(() => $selectedOrganization?.id);
	const stale = $derived($health.stale);
	void $page;
</script>

{#if stale}
	<div class="engine-banner">
		<Alert tone="warning" title="Live updates are down">
			What you see may be out of date until Orchard reconnects.
		</Alert>
	</div>
{/if}

<style>
	.engine-banner {
		padding: var(--space-3) var(--space-4) 0;
	}
</style>
