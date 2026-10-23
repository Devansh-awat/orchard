<script lang="ts">
	let { size = 16, label = undefined }: { size?: number; label?: string } = $props();
</script>

<svg
	class="spinner"
	width={size}
	height={size}
	viewBox="0 0 16 16"
	fill="none"
	role={label ? 'status' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	data-motion="progress"
>
	<circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-opacity="0.2" stroke-width="1.5" />
	<path
		d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
	/>
</svg>

<style>
	.spinner {
		flex-shrink: 0;
		animation: spin 0.7s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
