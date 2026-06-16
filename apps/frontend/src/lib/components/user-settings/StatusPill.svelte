<script lang="ts">
	let {
		active = false,
		label
	}: {
		active?: boolean;
		label: string;
	} = $props();
</script>

<div class="sp-root" class:sp-root--active={active}>
	<span class="sp-dot"></span>
	{label}
</div>

<style>
	.sp-root {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.1875rem 0.625rem;
		border-radius: 2rem;
		font-size: 0.6875rem;
		font-weight: 550;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--surface-muted) 8%, transparent);
		color: var(--surface-muted);
	}
	.sp-root--active {
		background-color: color-mix(in srgb, var(--online-indicator) 10%, transparent);
		color: var(--online-indicator);
	}
	.sp-dot {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 50%;
		background-color: currentColor;
	}
</style>
