<script lang="ts">
	import type { StatusMeta } from './status';

	let { meta, size = 8 }: { meta: StatusMeta; size?: number } = $props();
</script>

<span
	class="dot status--{meta.kind}"
	class:dot--pulse={meta.pulse}
	style="--dot-size: {size}px"
></span>

<style>
	.dot {
		display: inline-block;
		width: var(--dot-size);
		height: var(--dot-size);
		border-radius: 50%;
		background-color: currentColor;
		flex-shrink: 0;
	}

	.dot--pulse {
		animation: dot-pulse 1.6s ease-in-out infinite;
	}

	@keyframes dot-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.dot--pulse {
			animation: none;
		}
	}
</style>
