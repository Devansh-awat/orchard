<script lang="ts">
	import { onMount } from 'svelte';
	import SlackLink from '../components/greenhouse/SlackLink.svelte';
	import { captureUrlSecrets, urlSecret } from '../lib/utils/url-secrets';

	let token = $state<string | null>(null);
	let ready = $state(false);

	onMount(() => {
		captureUrlSecrets();
		token = urlSecret('link:slack');
		ready = true;
	});
</script>

<svelte:head>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

{#if ready}
	<SlackLink {token} />
{/if}
