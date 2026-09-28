<script lang="ts">
	let { class: className = '', compact = false }: { class?: string; compact?: boolean } = $props();
</script>

<span class="flex items-center gap-[6px] {className}">
	<img
		src="/brand/logo-tile.svg"
		alt={compact ? 'Orchard' : ''}
		width="32"
		height="32"
		class="size-8"
	/>
	{#if !compact}
		<img src="/brand/wordmark.svg" alt="Orchard" width="102" height="21" class="h-[21px] w-auto" />
	{/if}
</span>
