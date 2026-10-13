<script lang="ts">
	import type { Component } from 'svelte';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { queryClient } from '../host/query';

	let {
		component: View,
		props
	}: { component: Component<Record<string, unknown>>; props: Record<string, unknown> } = $props();
</script>

<QueryClientProvider client={queryClient}>
	<View {...props} />
</QueryClientProvider>
