<script lang="ts">
	interface IconProps {
		color?: string;
		size?: number;
		strokeWidth?: number;
		animate?: boolean;
		class?: string;
	}

	let {
		color = 'currentColor',
		size = 24,
		strokeWidth = 2,
		animate = $bindable(false),
		class: className = ''
	}: IconProps = $props();

	function handleMouseEnter() {
		if (animate) return;
		animate = true;
		setTimeout(() => {
			animate = false;
		}, 500);
	}
</script>

<div class={className} aria-label="circle-alert" role="img" onmouseenter={handleMouseEnter}>
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="none"
		stroke={color}
		stroke-width={strokeWidth}
		stroke-linecap="round"
		stroke-linejoin="round"
		class:animate-icon={animate}
	>
		<circle cx="12" cy="12" r="10" />
		<g class:animate-path={animate}>
			<line x1="12" x2="12" y1="8" y2="12" />
			<line x1="12" x2="12.01" y1="16" y2="16" />
		</g>
	</svg>
</div>

<style>
	div {
		display: inline-block;
		line-height: 0;
	}
	svg {
		display: block;
	}
	.animate-icon {
		animation: primaryAnimation 2.4s ease-in-out infinite;
		transform-origin: center;
	}

	@keyframes primaryAnimation {
		0% { transform: scale(1) rotate(0deg); }
		8% { transform: scale(1.1) rotate(-3deg); }
		16% { transform: scale(1.1) rotate(3deg); }
		24% { transform: scale(1.1) rotate(-2deg); }
		32%, 100% { transform: scale(1) rotate(0deg); }
	}
</style>
