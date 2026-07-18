<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';

	onMount(() => {
		goto(`/${$page.params.orgSlug}/settings?tab=audit`, { replaceState: true });
	});
</script>
