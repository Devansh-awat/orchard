<script lang="ts">
	import '../app.css';
	import jakarta from '$lib/assets/fonts/Plus_Jakarta_Sans/PlusJakartaSans-VariableFont_wght.woff2?url';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="preload" href={jakarta} as="font" type="font/woff2" crossorigin="anonymous" />
</svelte:head>

{@render children()}
