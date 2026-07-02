<script lang="ts">
	import { Search } from 'lucide-svelte';
	import { motionStagger } from '$lib/utils/motion.svelte';

	let { searchQuery = $bindable() }: { searchQuery: string } = $props();
</script>

<div class="bar" {@attach motionStagger({ index: 1, from: { y: 6 } })}>
	<div class="search-box">
		<Search size={14} />
		<input type="search" placeholder="Search apps..." class="search" bind:value={searchQuery} />
	</div>
</div>
