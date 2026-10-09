<script lang="ts">
	import type { Snippet } from 'svelte';
	import { X } from 'lucide-svelte';
	import { magneticHighlight } from '$lib/utils/motion.svelte';
	import type { StripTab } from './types';

	let {
		tabs,
		active = null,
		label = 'Open tabs',
		onselect,
		onclose = undefined,
		onreorder = undefined,
		leading = undefined,
		trailing = undefined,
		accessory = undefined
	}: {
		tabs: readonly StripTab[];
		active?: string | null;
		label?: string;
		onselect: (id: string) => void;
		onclose?: (id: string) => void;
		onreorder?: (from: number, to: number) => void;
		leading?: Snippet;
		trailing?: Snippet;
		accessory?: Snippet<[StripTab]>;
	} = $props();

	const nodes: Record<string, HTMLElement> = $state({});
	let dragging = $state<number | null>(null);
	let over = $state<number | null>(null);

	const activeNode = $derived(active ? nodes[active] : null);

	function closable(tab: StripTab) {
		return Boolean(onclose) && tab.closable !== false;
	}

	function onauxclick(e: MouseEvent, tab: StripTab) {
		if (e.button !== 1 || !closable(tab)) return;
		e.preventDefault();
		onclose?.(tab.id);
	}

	function onkeydown(e: KeyboardEvent, index: number) {
		if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
		e.preventDefault();
		const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
		if (!next) return;
		onselect(next.id);
		nodes[next.id]?.querySelector<HTMLButtonElement>('.strip-main')?.focus();
	}

	function ondragstart(e: DragEvent, index: number) {
		if (!onreorder) return;
		dragging = index;
		e.dataTransfer?.setData('text/plain', String(index));
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}

	function ondragover(e: DragEvent, index: number) {
		if (dragging === null) return;
		e.preventDefault();
		over = index;
	}

	function ondrop(e: DragEvent, index: number) {
		if (dragging === null) return;
		e.preventDefault();
		if (dragging !== index) onreorder?.(dragging, index);
		dragging = null;
		over = null;
	}

	function ondragend() {
		dragging = null;
		over = null;
	}
</script>

<div class="strip">
	{@render leading?.()}
	<div class="strip-tabs" role="tablist" aria-label={label}>
		<span
			class="strip-underline"
			aria-hidden="true"
			{@attach magneticHighlight(() => activeNode, {
				span: (tab) => tab.querySelector<HTMLElement>('.strip-label')
			})}
		></span>
		{#each tabs as tab, index (tab.id)}
			{@const selected = active === tab.id}
			<div
				class="strip-tab"
				class:strip-tab--active={selected}
				class:strip-tab--dirty={tab.dirty}
				class:strip-tab--closable={closable(tab)}
				class:strip-tab--over={over === index && dragging !== index}
				title={tab.tooltip ?? tab.title}
				bind:this={nodes[tab.id]}
				draggable={Boolean(onreorder)}
				ondragstart={(e) => ondragstart(e, index)}
				ondragover={(e) => ondragover(e, index)}
				ondrop={(e) => ondrop(e, index)}
				{ondragend}
				role="presentation"
			>
				<button
					type="button"
					role="tab"
					class="strip-main"
					aria-selected={selected}
					tabindex={selected ? 0 : -1}
					onclick={() => onselect(tab.id)}
					onauxclick={(e) => onauxclick(e, tab)}
					onkeydown={(e) => onkeydown(e, index)}
				>
					<span class="strip-label">
						{#if tab.icon}
							<span class="strip-icon"><tab.icon size={14} strokeWidth={1.75} /></span>
						{/if}
						<span class="strip-title">{tab.title}</span>
					</span>
				</button>
				{@render accessory?.(tab)}
				{#if closable(tab)}
					<button
						type="button"
						class="strip-close"
						tabindex="-1"
						aria-label={tab.dirty ? `Close ${tab.title}, unsaved changes` : `Close ${tab.title}`}
						onclick={() => onclose?.(tab.id)}
					>
						<span class="strip-dot" aria-hidden="true"></span>
						<span class="strip-x" aria-hidden="true"><X size={12} strokeWidth={2} /></span>
					</button>
				{:else if tab.dirty}
					<span class="strip-close"><span class="strip-dot" aria-hidden="true"></span></span>
				{/if}
			</div>
		{/each}
	</div>
	<div class="strip-fill">{@render trailing?.()}</div>
</div>

<style>
	.strip {
		display: flex;
		align-items: stretch;
		height: 2.25rem;
		min-width: 0;
		border-bottom: 1px solid var(--border-default);
		background: var(--gh-editor, var(--bg-app));
	}

	.strip-tabs {
		position: relative;
		display: flex;
		align-items: stretch;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.strip-underline {
		z-index: 1;
		pointer-events: none;
		opacity: 0;
		background: linear-gradient(
			to top,
			var(--text-default) 0,
			var(--text-default) 2px,
			transparent 2px
		);
	}

	.strip-tab {
		position: relative;
		display: flex;
		align-items: center;
		flex: none;
		max-width: 15rem;
		padding-right: 0.375rem;
		color: var(--text-muted);
		transition: color var(--dur-fast) ease;
	}

	.strip-tab:not(.strip-tab--closable):not(.strip-tab--dirty) {
		padding-right: 0.5rem;
	}

	.strip-tab:hover,
	.strip-tab--active {
		color: var(--text-default);
	}

	.strip-tab--over {
		box-shadow: inset 2px 0 0 var(--focus-ring-color);
	}

	.strip-main {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		height: 100%;
		min-width: 0;
		padding: 0 0.25rem 0 0.75rem;
		font-size: var(--text-footnote);
		font-weight: 400;
		color: inherit;
		outline: none;
	}

	.strip-main:focus-visible {
		box-shadow: inset 0 0 0 2px var(--focus-ring);
		border-radius: var(--radius-xs);
	}

	.strip-tab--active .strip-main {
		font-weight: 500;
	}

	.strip-label {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
	}

	.strip-icon {
		display: grid;
		place-items: center;
		flex: none;
		color: var(--text-muted);
	}

	.strip-tab--active .strip-icon,
	.strip-tab:hover .strip-icon {
		color: var(--text-default);
	}

	.strip-title {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.strip-close {
		position: relative;
		display: grid;
		place-items: center;
		flex: none;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: var(--radius-xs);
		color: var(--text-faint);
		transition:
			color var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}

	button.strip-close:hover {
		color: var(--text-default);
		background: var(--bg-hover);
	}

	.strip-dot,
	.strip-x {
		grid-area: 1 / 1;
		display: grid;
		place-items: center;
		transition: opacity var(--dur-fast) ease;
	}

	.strip-dot {
		width: 0.4375rem;
		height: 0.4375rem;
		border-radius: 999px;
		background: var(--text-muted);
		opacity: 0;
	}

	.strip-x {
		opacity: 0;
	}

	.strip-tab:hover .strip-x,
	.strip-close:focus-visible .strip-x {
		opacity: 1;
	}

	.strip-tab--dirty .strip-dot {
		opacity: 1;
	}

	.strip-tab--dirty.strip-tab--closable:hover .strip-dot {
		opacity: 0;
	}

	.strip-fill {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.25rem;
		min-width: 0;
		padding: 0 0.5rem;
	}
</style>
