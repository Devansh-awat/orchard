<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { StatusKind } from '$lib/components/ui';

	let {
		tone = 'success',
		moving = false,
		hollowEnd = false,
		children
	}: {
		tone?: StatusKind;
		moving?: boolean;
		hollowEnd?: boolean;
		children: Snippet;
	} = $props();
</script>

<div class="rp rp--{tone}" class:rp--moving={moving} aria-hidden="true">
	<span class="rp-dot"></span>
	<span class="rp-line"></span>
	{#if moving}<span class="rp-runner" data-motion="progress"></span>{/if}
	<span class="rp-chip">{@render children()}</span>
	<span class="rp-line"></span>
	<span class="rp-dot rp-dot--end" class:rp-dot--hollow={hollowEnd}></span>
</div>

<style>
	.rp {
		position: relative;
		display: flex;
		align-items: center;
		min-width: 0;
		height: 2.5rem;
	}
	.rp--success {
		--rp-tone: var(--status-success);
	}
	.rp--progress {
		--rp-tone: var(--status-progress);
	}
	.rp--error {
		--rp-tone: var(--status-error);
	}
	.rp--warning {
		--rp-tone: var(--status-warning);
	}
	.rp--info {
		--rp-tone: var(--status-info);
	}
	.rp--neutral {
		--rp-tone: var(--status-neutral);
	}
	.rp-line {
		flex: 1;
		height: 0;
		border-top: 1.5px dashed var(--border-strong);
	}
	.rp-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--border-strong);
		flex-shrink: 0;
	}
	.rp-dot--end {
		background: var(--rp-tone);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--rp-tone) 18%, transparent);
	}
	.rp-dot--hollow {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--rp-tone);
	}
	.rp-chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: 0.25rem 0.625rem;
		border-radius: var(--radius-pill);
		background: var(--bg-surface);
		box-shadow: inset 0 0 0 1px var(--border-default);
		color: var(--text-muted);
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		font-weight: 500;
		white-space: nowrap;
		flex-shrink: 0;
		margin: 0 var(--space-1);
		position: relative;
		z-index: 1;
	}
	.rp--moving .rp-chip {
		color: var(--text-default);
	}
	.rp-runner {
		position: absolute;
		top: 50%;
		left: 0;
		width: 0.375rem;
		height: 0.375rem;
		margin-top: -0.1875rem;
		border-radius: 50%;
		background: var(--rp-tone);
		animation: rp-run 2.4s linear infinite;
	}
	@keyframes rp-run {
		from {
			left: 0;
			opacity: 0;
		}
		10% {
			opacity: 1;
		}
		90% {
			opacity: 1;
		}
		to {
			left: 100%;
			opacity: 0;
		}
	}
	@media (max-width: 760px) {
		.rp {
			height: 1.5rem;
		}
	}
</style>
