<script lang="ts">
	import type { StatusMeta } from './status';

	let { meta, size = 8 }: { meta: StatusMeta; size?: number } = $props();
</script>

<span
	class="dot dot--{meta.kind}"
	class:dot--live={meta.pulse}
	style:--dot-size="{size}px"
	data-motion={meta.pulse ? 'progress' : undefined}
	aria-hidden="true"
></span>

<style>
	.dot {
		position: relative;
		display: inline-block;
		flex-shrink: 0;
		width: var(--dot-size);
		height: var(--dot-size);
		border-radius: 50%;
		background: var(--dot-color);
	}
	.dot--success {
		--dot-color: var(--status-success-solid);
	}
	.dot--warning {
		--dot-color: var(--status-warning-solid);
	}
	.dot--error {
		--dot-color: var(--status-error-solid);
	}
	.dot--info {
		--dot-color: var(--status-info-solid);
	}
	.dot--neutral {
		--dot-color: var(--neutral-6);
	}
	.dot--progress {
		--dot-color: var(--status-progress-solid);
	}
	.dot--live {
		background: none;
	}
	.dot--live::before,
	.dot--live::after {
		content: '';
		position: absolute;
		border-radius: 50%;
	}
	.dot--live::before {
		inset: 28%;
		background: var(--dot-color);
	}
	.dot--live::after {
		inset: 0;
		background: conic-gradient(
			var(--dot-color) 0 28%,
			color-mix(in oklab, var(--dot-color) 22%, transparent) 28% 100%
		);
		mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), black calc(100% - 1.25px));
		animation: orbit 0.9s linear infinite;
	}
	@keyframes orbit {
		to {
			transform: rotate(1turn);
		}
	}
</style>
