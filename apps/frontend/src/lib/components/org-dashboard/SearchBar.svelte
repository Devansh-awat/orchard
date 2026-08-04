<script lang="ts">
	import { Search } from 'lucide-svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';

	let { searchQuery = $bindable() }: { searchQuery: string } = $props();
</script>

<div class="search-box" {@attach motionStagger({ index: 1, from: { y: 6 } })}>
	<Search size={14} />
	<input type="search" placeholder="Search apps..." class="search" bind:value={searchQuery} />
</div>
