<script lang="ts">
	import NumberRoll from '$lib/components/ui/NumberRoll.svelte';
	let n = $state(1734);
	const fmt = (v: number) => (v > 999 ? `${(v / 1000).toFixed(1)}k/h` : `${v}/h`);
</script>

<div class="lab">
	<p class="big">Requests <NumberRoll value={fmt(n)} /> today</p>
	<p class="small">Elapsed <NumberRoll value={`1:${String(n % 60).padStart(2, '0')}`} /> total</p>
	<button onclick={() => (n += 137)}>Bump</button>
	<button onclick={() => (n -= 911)}>Drop</button>
</div>

<style>
	.lab {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 3rem;
	}
	.big {
		font-size: 2rem;
	}
	.small {
		font-size: var(--text-caption);
	}
</style>
