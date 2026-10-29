<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { SpringValue, functionalMotion } from '$lib/utils/motion.svelte';

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

	let sheet = $state<HTMLElement>();
	let originX = $state(50);
	let originY = $state(0);
	let closing = $state(false);
	const progress = new SpringValue(0);

	function measure() {
		const el = sheet;
		const pill = origin;
		if (!el || !pill) return;
		const box = el.getBoundingClientRect();
		const o = pill.getBoundingClientRect();
		if (!o.width || !box.width) return;
		originX = ((o.left + o.width / 2 - box.left) / box.width) * 100;
		originY = ((o.top + o.height / 2 - box.top) / box.height) * 100;
	}

	$effect(() => {
		if (!sheet) return;
		untrack(() => {
			measure();
			progress.to(1, 'morph', { instant: !functionalMotion() });
		});
	});

	$effect(() => {
		if (closing && progress.current <= 0.02) untrack(onclose);
	});

	export function close() {
		if (closing) return;
		closing = true;
		progress.to(0, 'settle', { instant: !functionalMotion() });
	}

	const k = $derived(Math.max(0, progress.current));
</script>

<div
	bind:this={sheet}
	class="sheet sheet--{tone}"
	role="dialog"
	aria-modal="false"
	tabindex="-1"
	style:opacity={Math.min(1, k)}
	style:transform="scale({0.94 + 0.06 * k})"
	style:transform-origin="{originX}% {originY}%"
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			e.stopPropagation();
			close();
		}
	}}
>
	<div class="content" inert={closing}>
		{@render children()}
	</div>
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
		will-change: transform, opacity;
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
	}
</style>
