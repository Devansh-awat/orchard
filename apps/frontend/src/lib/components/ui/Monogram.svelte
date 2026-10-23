<script lang="ts">
	let { name, size = 'md' }: { name: string; size?: 'sm' | 'md' } = $props();

	const HUES = ['accent', 'blue', 'green', 'amber', 'red'] as const;
	const hue = $derived(
		HUES[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length]
	);
	const letter = $derived(name.trim().charAt(0).toUpperCase());
</script>

<span class="mono mono--{size}" style:--tone-bg="var(--{hue}-3)" style:--tone-fg="var(--{hue}-9)"
	>{letter}</span
>

<style>
	.mono {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		border-radius: 0.375rem;
		background: var(--tone-bg);
		color: var(--tone-fg);
		box-shadow: inset 0 0 0 0.5px color-mix(in oklab, var(--tone-fg) 18%, transparent);
		font-weight: var(--weight-semibold);
		line-height: 1;
	}
	.mono--sm {
		width: 1.125rem;
		height: 1.125rem;
		font-size: 0.625rem;
		border-radius: 0.3125rem;
	}
	.mono--md {
		width: 1.5rem;
		height: 1.5rem;
		font-size: var(--text-caption);
	}
</style>
