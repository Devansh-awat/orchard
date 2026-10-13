<script lang="ts">
	import { onMount } from 'svelte';
	import ShareViewer from '../components/greenhouse/ShareViewer.svelte';
	import { user } from '../host/stores';
	import { captureUrlSecrets, urlSecret } from '../lib/utils/url-secrets';

	let token = $state<string | null>(null);
	let ready = $state(false);

	function read() {
		captureUrlSecrets();
		token = urlSecret('share:sandbox');
	}

	onMount(() => {
		read();
		ready = true;
		window.addEventListener('hashchange', read);
		return () => window.removeEventListener('hashchange', read);
	});
</script>

<svelte:head>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

{#if ready}
	<ShareViewer {token} selfId={$user?.id ?? null} />
{/if}
