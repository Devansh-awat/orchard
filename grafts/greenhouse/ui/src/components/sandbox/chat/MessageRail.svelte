<script lang="ts">
	import { fade } from '../../../lib/utils/transitions';
	import type { RailMark } from './turns';

	let {
		marks,
		inView,
		onjump
	}: {
		marks: RailMark[];
		inView: ReadonlySet<string>;
		onjump: (key: string) => void;
	} = $props();

	let railEl = $state<HTMLElement | undefined>(undefined);
	let tip = $state<{ key: string; top: number } | null>(null);
	let focusKey = $state<string | null>(null);

	const tipMark = $derived(tip ? (marks.find((m) => m.key === tip?.key) ?? null) : null);
	const rover = $derived.by(() => {
		if (focusKey && marks.some((m) => m.key === focusKey)) return focusKey;
		for (let i = marks.length - 1; i >= 0; i -= 1) {
			if (inView.has(marks[i].key)) return marks[i].key;
		}
		return marks[marks.length - 1]?.key ?? null;
	});

	function show(key: string, el: HTMLElement) {
		if (!railEl) return;
		const rail = railEl.getBoundingClientRect();
		const box = el.getBoundingClientRect();
		tip = { key, top: box.top + box.height / 2 - rail.top };
	}

	function hide(key: string) {
		if (tip?.key === key) tip = null;
	}

	function move(event: KeyboardEvent, index: number) {
		const keys: Record<string, number> = {
			ArrowUp: index - 1,
			ArrowDown: index + 1,
			Home: 0,
			End: marks.length - 1
		};
		const next = keys[event.key];
		if (next === undefined) return;
		event.preventDefault();
		const target = marks[Math.max(0, Math.min(marks.length - 1, next))];
		if (!target) return;
		focusKey = target.key;
		railEl
			?.querySelector<HTMLButtonElement>(`[data-rail-key="${CSS.escape(target.key)}"]`)
			?.focus();
	}

	function label(mark: RailMark): string {
		const what =
			mark.kind === 'agent'
				? mark.live
					? 'Agent, working now'
					: 'Agent reply'
				: mark.kind === 'comment'
					? 'Comment'
					: 'Prompt';
		const who = mark.kind === 'agent' ? '' : ` from ${mark.who}`;
		return `${what}${who}: ${mark.preview}`;
	}
</script>

<nav class="rail" aria-label="Jump to a message" bind:this={railEl}>
	<div class="rail-ticks">
		{#each marks as mark, i (mark.key)}
			<button
				type="button"
				class="tick tick--{mark.kind}"
				class:tick--in={inView.has(mark.key)}
				class:tick--live={mark.live}
				data-rail-key={mark.key}
				tabindex={mark.key === rover ? 0 : -1}
				aria-label={label(mark)}
				aria-current={inView.has(mark.key) ? 'location' : undefined}
				onclick={() => onjump(mark.key)}
				onkeydown={(event) => move(event, i)}
				onmouseenter={(event) => show(mark.key, event.currentTarget)}
				onmouseleave={() => hide(mark.key)}
				onfocus={(event) => {
					focusKey = mark.key;
					show(mark.key, event.currentTarget);
				}}
				onblur={() => hide(mark.key)}
			>
				<span class="tick-line"></span>
			</button>
		{/each}
	</div>
	{#if tip && tipMark}
		<div class="tip" style:top="{tip.top}px" aria-hidden="true" transition:fade={{ duration: 120 }}>
			<span class="tip-who">{tipMark.live ? 'Agent, working now' : tipMark.who}</span>
			<span class="tip-text">{tipMark.preview}</span>
		</div>
	{/if}
</nav>

<style>
	.rail {
		position: absolute;
		top: 50%;
		right: var(--space-4);
		z-index: 2;
		display: flex;
		max-height: calc(100% - var(--space-12) * 2);
		transform: translateY(-50%);
	}

	.rail-ticks {
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
		border-radius: var(--radius-xs);
	}

	.tick {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		flex: 0 1 0.5rem;
		min-height: 0.1875rem;
		width: 1.5rem;
		padding: 0 var(--space-1);
		border: none;
		background: none;
		cursor: pointer;
	}

	.tick--in {
		background: var(--fill-quiet);
	}

	.tick:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}

	.tick-line {
		display: block;
		height: 0.125rem;
		max-height: 100%;
		border-radius: var(--radius-pill);
		background: var(--text-faint);
		opacity: 0.6;
		transition:
			background-color var(--dur-fast),
			opacity var(--dur-fast);
	}

	.tick--agent .tick-line {
		width: 0.375rem;
	}

	.tick--comment .tick-line {
		width: 0.5rem;
	}

	.tick--prompt .tick-line {
		width: 0.75rem;
		background: var(--text-muted);
		opacity: 0.8;
	}

	.tick--in .tick-line {
		opacity: 1;
	}

	.tick--in.tick--prompt .tick-line {
		background: var(--text-default);
	}

	.tick--live .tick-line {
		background: var(--status-success);
		opacity: 1;
	}

	.tick:hover .tick-line,
	.tick:focus-visible .tick-line {
		background: var(--text-default);
		opacity: 1;
	}

	.tip {
		position: absolute;
		right: calc(100% + var(--space-2));
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		width: max-content;
		max-width: 16rem;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--bg-overlay);
		box-shadow: var(--elev-2);
		transform: translateY(-50%);
		pointer-events: none;
	}

	.tip-who {
		font-size: var(--text-caption);
		line-height: 1rem;
		font-weight: 600;
		color: var(--text-muted);
	}

	.tip-text {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-default);
		overflow-wrap: anywhere;
	}

	@container chat-pane (max-width: 40rem) {
		.rail {
			display: none;
		}
	}

	@media (max-width: 47.99rem), (pointer: coarse) {
		.rail {
			display: none;
		}
	}
</style>
