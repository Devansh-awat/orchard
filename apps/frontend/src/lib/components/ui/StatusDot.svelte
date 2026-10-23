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
	.dot--live::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: var(--dot-color);
		animation: ripple 1.6s cubic-bezier(0, 0, 0.2, 1) infinite;
	}
	@keyframes ripple {
		from {
			transform: scale(1);
			opacity: 0.6;
		}
		to {
			transform: scale(2.6);
			opacity: 0;
		}
	}
</style>
