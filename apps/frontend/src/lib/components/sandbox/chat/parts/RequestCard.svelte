<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		el = $bindable(),
		label,
		readonly = false,
		focusOnMount = false,
		onkey = undefined,
		header,
		children,
		actions = undefined
	}: {
		el?: HTMLElement;
		label: string;
		readonly?: boolean;
		focusOnMount?: boolean;
		onkey?: (e: KeyboardEvent) => void;
		header: Snippet;
		children?: Snippet;
		actions?: Snippet;
	} = $props();

	function typing(): boolean {
		const active = document.activeElement;
		if (!(active instanceof HTMLElement)) return false;
		return active.isContentEditable || active.matches('input, textarea, select');
	}

	function claimFocus(node: HTMLElement) {
		if (!focusOnMount || readonly) return;
		const frame = requestAnimationFrame(() => {
			if (!typing()) node.focus({ preventScroll: true });
		});
		return () => cancelAnimationFrame(frame);
	}
</script>

<div
	bind:this={el}
	class="ask"
	class:ask--readonly={readonly}
	role="dialog"
	aria-label={label}
	tabindex={readonly ? undefined : 0}
	onkeydown={onkey}
	{@attach claimFocus}
>
	<div class="ask-head" data-align="content">{@render header()}</div>
	{@render children?.()}
	{#if readonly}
		<p class="ask-wait" data-align="content">Waiting for someone who can prompt the agent</p>
	{:else if actions}
		<div class="ask-actions" data-align="content">{@render actions()}</div>
	{/if}
</div>

<style>
	.ask {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
		margin: 0 calc(-1 * var(--space-4));
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);
		background: var(--bg-raised);
		box-shadow:
			0 0 0 1px var(--border-default),
			var(--elev-1);
		transition: box-shadow var(--dur-fast);
	}

	.ask:focus {
		outline: none;
		box-shadow:
			0 0 0 1px var(--border-strong),
			var(--elev-1);
	}

	.ask:focus-visible {
		box-shadow:
			0 0 0 2px var(--focus-ring),
			var(--elev-1);
	}

	.ask--readonly {
		background: var(--bg-surface);
		box-shadow: 0 0 0 1px var(--border-default);
	}

	.ask-head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		min-height: 1.25rem;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-default);
	}

	.ask-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.ask-wait {
		margin: 0;
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
	}
</style>
