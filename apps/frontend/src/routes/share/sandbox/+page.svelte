<script lang="ts">
	import { onMount } from 'svelte';
	import ShareViewer from '$lib/components/greenhouse/ShareViewer.svelte';
	import { user } from '$lib/stores';

	let token = $state<string | null>(null);
	let ready = $state(false);

	function read() {
		const value = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
		token = value || null;
	}

	onMount(() => {
		read();
		ready = true;
		window.addEventListener('hashchange', read);
		return () => window.removeEventListener('hashchange', read);
	});
</script>

<svelte:head>
	<title>Shared session · Greenhouse</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

{#if ready}
	<ShareViewer {token} selfId={$user?.id ?? null} />
{/if}
