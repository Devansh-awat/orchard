<script lang="ts">
	let {
		name,
		alt,
		priority = false
	}: {
		name: string;
		alt: string;
		priority?: boolean;
	} = $props();
</script>

<img
	src="/screenshots/{name}-dark.png"
	{alt}
	width="1600"
	height="1000"
	loading={priority ? 'eager' : 'lazy'}
	fetchpriority={priority ? 'high' : 'auto'}
	class="w-full rounded-lg border-4 border-crimson"
/>
