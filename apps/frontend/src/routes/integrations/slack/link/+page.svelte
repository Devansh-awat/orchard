<script lang="ts">
	import { page } from '$app/state';
	import SlackLink from '$lib/components/greenhouse/SlackLink.svelte';
</script>

<svelte:head>
	<title>Link Slack · Orchard</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<SlackLink token={page.url.searchParams.get('token')} />
