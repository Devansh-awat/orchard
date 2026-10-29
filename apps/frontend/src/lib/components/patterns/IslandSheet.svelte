<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { springTiming, functionalMotion } from '$lib/utils/motion.svelte';

	let {
		origin,
		tone = 'ok',
		onclose,
		children
	}: {
		origin: HTMLElement | null;
		tone?: 'ok' | 'warn' | 'bad';
		onclose: () => void;
		children: Snippet;
	} = $props();

	const PILL_R = 18;

	let sheet = $state<HTMLElement>();
	let closing = false;

	function insetFrom(): string | null {
		if (!sheet || !origin) return null;
		const box = sheet.getBoundingClientRect();
		const o = origin.getBoundingClientRect();
		if (!o.width) return null;
		const scale = parseFloat(getComputedStyle(sheet).getPropertyValue('--corner-scale')) || 1;
		const r = PILL_R * scale;
		return `inset(${o.top - box.top}px ${box.right - o.right}px ${box.bottom - o.bottom}px ${o.left - box.left}px round ${r}px)`;
	}

	function fullInset(): string {
		const r = sheet ? getComputedStyle(sheet).borderTopLeftRadius : '0px';
		return `inset(0px 0px 0px 0px round ${r})`;
	}

	$effect(() => {
		const el = sheet;
		if (!el) return;
		void tick().then(() => {
			const from = insetFrom();
			if (!from || !functionalMotion()) return;
			el.animate([{ clipPath: from }, { clipPath: fullInset() }], springTiming('morph'));
		});
	});

	export async function close() {
		if (closing) return;
		closing = true;
		const el = sheet;
		const to = insetFrom();
		if (el && to && functionalMotion()) {
			el.dataset.closing = '';
			await el
				.animate([{ clipPath: fullInset() }, { clipPath: to }], {
					...springTiming('morph', { exit: true }),
					fill: 'forwards'
				})
				.finished.catch(() => {});
		}
		onclose();
	}
</script>

<div
	bind:this={sheet}
	class="sheet sheet--{tone}"
	role="dialog"
	aria-modal="false"
	tabindex="-1"
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			e.stopPropagation();
			close();
		}
	}}
>
	<div class="content">{@render children()}</div>
</div>

<style>
	.sheet {
		--island-fg: var(--text-default);
		--island-muted: var(--text-muted);
		--island-faint: var(--text-faint);
		--island-rule: var(--border-default);
		--island-ok: var(--status-success);
		--island-tone: var(--text-default);
		position: absolute;
		inset: 0;
		z-index: 2;
		display: flex;
		flex-direction: column;
		border-radius: calc(var(--radius-widget) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow:
			inset 0 0 0 0.5px var(--border-strong),
			var(--shadow-raised);
		color: var(--island-fg);
		outline: none;
	}
	.sheet--warn {
		--island-tone: var(--status-warning);
	}
	.sheet--bad {
		--island-tone: var(--status-error);
	}
	.content {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
		padding: 1rem;
		overflow-y: auto;
		animation: content-in var(--fade-long) var(--curve-out) 90ms both;
	}
	.sheet[data-closing] .content {
		animation: content-out var(--fade-out) var(--curve-in) forwards;
	}
	@keyframes content-in {
		from {
			opacity: 0;
			filter: blur(6px);
		}
	}
	@keyframes content-out {
		to {
			opacity: 0;
			filter: blur(6px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.content,
		.sheet[data-closing] .content {
			animation: none;
		}
	}
</style>
