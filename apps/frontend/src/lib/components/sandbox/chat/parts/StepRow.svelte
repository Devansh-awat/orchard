<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ChevronRight, CircleX, LoaderCircle } from 'lucide-svelte';
	import { springRotate } from '$lib/utils/motion.svelte';
	import { slide } from '$lib/utils/transitions';

	let {
		title,
		arg = null,
		hint = undefined,
		running = false,
		failed = false,
		nested = false,
		expanded = null,
		ontoggle = undefined,
		icon,
		trailing = undefined,
		children = undefined
	}: {
		title: string;
		arg?: string | null;
		hint?: string;
		running?: boolean;
		failed?: boolean;
		nested?: boolean;
		expanded?: boolean | null;
		ontoggle?: () => void;
		icon: Snippet;
		trailing?: Snippet;
		children?: Snippet;
	} = $props();

	const expandable = $derived(expanded !== null && !!ontoggle);
</script>

<div class="srow" class:srow--running={running}>
	<button
		type="button"
		class="srow-head"
		data-align={nested ? undefined : 'step'}
		aria-expanded={expandable ? !!expanded : undefined}
		disabled={!expandable}
		title={hint}
		onclick={() => ontoggle?.()}
	>
		<span class="srow-icon" class:srow-icon--failed={failed} aria-hidden="true">
			{#if running}
				<span class="srow-spin" data-motion="progress"
					><LoaderCircle size={16} strokeWidth={1.75} /></span
				>
			{:else if failed}
				<CircleX size={16} strokeWidth={1.75} />
			{:else}
				{@render icon()}
			{/if}
		</span>
		<span class="srow-title">{title}</span>
		{#if arg}<code class="srow-arg">{arg}</code>{/if}
		{@render trailing?.()}
		{#if failed}<span class="srow-failed">Failed</span>{/if}
		{#if expandable}
			<span class="srow-chev" {@attach springRotate(() => !!expanded, { rest: 0, on: 90 })}>
				<ChevronRight size={16} strokeWidth={1.75} />
			</span>
		{/if}
	</button>
	{#if expandable && expanded && children}
		<div class="srow-detail" transition:slide>
			{@render children()}
		</div>
	{/if}
</div>

<style>
	.srow {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.srow-head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		max-width: 100%;
		width: fit-content;
		min-height: 2rem;
		padding: 0;
		border: none;
		border-radius: var(--radius-xs);
		background: none;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-muted);
		text-align: left;
		cursor: pointer;
		transition: color var(--dur-fast);
	}

	.srow-head:disabled {
		cursor: default;
	}

	.srow-head:hover:not(:disabled),
	.srow--running .srow-head {
		color: var(--text-default);
	}

	.srow-icon {
		display: inline-flex;
		flex-shrink: 0;
		width: 1rem;
		height: 1rem;
		color: var(--text-faint);
	}

	.srow--running .srow-icon {
		color: var(--text-muted);
	}

	.srow-icon--failed {
		color: var(--status-error);
	}

	.srow-spin {
		display: inline-flex;
		animation: srow-spin 1s linear infinite;
	}

	.srow-title {
		flex-shrink: 0;
		max-width: 60%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.srow-arg {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding: 0.125rem var(--space-2);
		border-radius: var(--radius-xs);
		background: var(--fill-quiet);
		font-family: var(--gh-mono, var(--font-mono, monospace));
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}

	.srow-failed {
		flex-shrink: 0;
		font-weight: 600;
		color: var(--text-default);
	}

	.srow-chev {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-faint);
		opacity: 0;
		transition: opacity var(--dur-fast);
	}

	.srow-head:hover .srow-chev,
	.srow-head:focus-visible .srow-chev,
	.srow-head[aria-expanded='true'] .srow-chev {
		opacity: 1;
	}

	.srow-detail {
		display: flex;
		flex-direction: column;
		min-width: 0;
		margin: 0 0 var(--space-2) var(--space-6);
	}

	@keyframes srow-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
