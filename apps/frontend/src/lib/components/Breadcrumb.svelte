<script lang="ts">
	import Breadcrumbs from './ui/Breadcrumbs.svelte';
	let { crumbs }: { crumbs: { label: string; href?: string }[] } = $props();
</script>

<div class="mb-4"><Breadcrumbs {crumbs} /></div>
