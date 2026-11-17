<script lang="ts">
	import logoTile from '$lib/assets/brand/logo-tile.svg';
	import wordmark from '$lib/assets/brand/wordmark.svg';

	let { class: className = '', compact = false }: { class?: string; compact?: boolean } = $props();
</script>

<span class="flex items-center gap-2 {className}">
	<img
		src={logoTile}
		alt={compact ? 'Hack Club Orchard' : ''}
		width="32"
		height="32"
		class="size-9"
	/>
	{#if !compact}
		<span class="flex flex-col items-start gap-1.5">
			<span class="-ml-px text-[12px] leading-[9px] font-bold tracking-[0.01em] text-white">
				Hack Club
			</span>
			<img src={wordmark} alt="Orchard" width="102" height="21" class="h-[21px] w-auto" />
		</span>
	{/if}
</span>
