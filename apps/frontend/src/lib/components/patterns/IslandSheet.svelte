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

	const PILL_R = 18;

	type Edges = { t: number; r: number; b: number; l: number; radius: number };

	let sheet = $state<HTMLElement>();
	let from = $state<Edges>({ t: 0, r: 0, b: 0, l: 0, radius: 0 });
	let full = $state(0);
	let closing = $state(false);
	const progress = new SpringValue(0);

	function measure() {
		const el = sheet;
		const pill = origin;
		if (!el || !pill) return;
		const box = el.getBoundingClientRect();
		const o = pill.getBoundingClientRect();
		if (!o.width) return;
		const style = getComputedStyle(el);
		const scale = parseFloat(style.getPropertyValue('--corner-scale')) || 1;
		from = {
			t: o.top - box.top,
			r: box.right - o.right,
			b: box.bottom - o.bottom,
			l: o.left - box.left,
			radius: Math.min(PILL_R * scale, o.height / 2)
		};
		full = parseFloat(style.borderTopLeftRadius) || 0;
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
		measure();
		progress.to(0, 'morph', { settle: true, instant: !functionalMotion() });
	}

	const k = $derived(progress.current);
	const along = (a: number) => a * (1 - k);
	const clip = $derived(
		`inset(${along(from.t)}px ${along(from.r)}px ${along(from.b)}px ${along(from.l)}px round ${from.radius + (full - from.radius) * Math.min(1, Math.max(0, k))}px)`
	);
	const reveal = $derived(Math.min(1, Math.max(0, (k - 0.45) / 0.45)));
</script>

<div
	bind:this={sheet}
	class="sheet sheet--{tone}"
	role="dialog"
	aria-modal="false"
	tabindex="-1"
	style:clip-path={clip}
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			e.stopPropagation();
			close();
		}
	}}
>
	<div
		class="content"
		style:opacity={reveal}
		style:filter={reveal < 1 ? `blur(${(1 - reveal) * 6}px)` : undefined}
		inert={closing}
	>
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
		box-shadow: inset 0 0 0 0.5px var(--border-strong);
		color: var(--island-fg);
		outline: none;
		will-change: clip-path;
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
