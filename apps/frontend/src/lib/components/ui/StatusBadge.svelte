<script lang="ts">
	import type { StatusMeta } from './status';
	import StatusDot from './StatusDot.svelte';

	let {
		meta,
		variant = 'subtle'
	}: {
		meta: StatusMeta;
		variant?: 'subtle' | 'plain' | 'solid';
	} = $props();
</script>

{#if variant === 'subtle'}
	<span class="sb sb--subtle status--{meta.kind}">
		<StatusDot {meta} size={6} />
		{meta.label}
	</span>
{:else if variant === 'solid'}
	<span class="sb sb--solid status--{meta.kind}">
		<span class="sb-solid-inner">
			<span class="sb-solid-dot" class:sb-solid-dot--pulse={meta.pulse} aria-hidden="true"></span>
			{meta.label}
		</span>
	</span>
{:else}
	<span class="sb sb--plain">
		<StatusDot {meta} size={6} />
		{meta.label}
	</span>
{/if}

<style>
	.sb {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		font-weight: 600;
		flex-shrink: 0;
		white-space: nowrap;
	}

	.sb--subtle {
		padding: 0.25rem 0.75rem;
		border-radius: var(--radius-2xl);
		background-color: color-mix(in srgb, currentColor 10%, transparent);
	}

	.sb--plain {
		color: var(--text-default);
	}

	.sb--solid {
		padding: 0.3125rem 0.75rem;
		border-radius: var(--radius-2xl);
		background-color: currentColor;
		box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text-on-accent) 24%, transparent);
	}

	.sb-solid-inner {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--text-on-accent);
		font-weight: 700;
		letter-spacing: 0.02em;
	}

	.sb-solid-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
		opacity: 0.85;
	}

	.sb-solid-dot--pulse {
		animation: sb-pulse 1.6s ease-in-out infinite;
	}

	@keyframes sb-pulse {
		0%,
		100% {
			opacity: 0.85;
			transform: scale(1);
		}
		50% {
			opacity: 0.45;
			transform: scale(0.75);
		}
	}
</style>
