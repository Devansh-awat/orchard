<script lang="ts">
	let {
		width = '100%',
		height = '1rem',
		rounded = '0.5rem',
		class: className = ''
	}: {
		width?: string;
		height?: string;
		rounded?: string;
		class?: string;
	} = $props();
</script>

<div
	class="bone{className ? ` ${className}` : ''}"
	style:width
	style:height
	style:border-radius={rounded}
	aria-hidden="true"
></div>

<style>
	.bone {
		--sheen: color-mix(in oklab, var(--bg-surface) 55%, transparent);
		position: relative;
		background: var(--skeleton-base);
		overflow: hidden;
		isolation: isolate;
		animation: bone-in 180ms ease-out 160ms both;
	}
	.bone::after {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(90deg, transparent 0%, var(--sheen) 50%, transparent 100%);
		transform: translateX(-100%);
		animation: bone-sheen 2.2s cubic-bezier(0.4, 0, 0.2, 1) 0.4s infinite;
	}
	:global(.dark) .bone {
		--sheen: color-mix(in oklab, var(--ink) 6%, transparent);
	}
	@keyframes bone-in {
		from {
			opacity: 0;
		}
	}
	@keyframes bone-sheen {
		0% {
			transform: translateX(-100%);
		}
		60%,
		100% {
			transform: translateX(100%);
		}
	}
</style>
