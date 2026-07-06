<script lang="ts">
	import { page } from '$app/stores';
	import ErrorPage from '$lib/components/ErrorPage.svelte';

	const GENERIC_KIT_MESSAGES = new Set(['Not Found', 'Internal Error', 'Internal Server Error']);
	const message = $derived.by(() => {
		const m = $page.error?.message ?? '';
		return GENERIC_KIT_MESSAGES.has(m) ? '' : m;
	});
</script>

<ErrorPage status={$page.status} {message} />
