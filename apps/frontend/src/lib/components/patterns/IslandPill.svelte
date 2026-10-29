<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { SpringValue, functionalMotion } from '$lib/utils/motion.svelte';

	let {
		open = $bindable(false),
		tone = 'ok',
		label,
		face,
		children
	}: {
		open?: boolean;
		tone?: 'ok' | 'warn' | 'bad';
		label: string;
		face: Snippet;
		children: Snippet<[{ close: () => void }]>;
	} = $props();

	const FACE_H = 36;
	const R_CLOSED = 18;
	const R_OPEN = 24;

	const id = $props.id();
	let sheet = $state<HTMLElement>();
	let sheetH = $state(FACE_H);
	let rendered = $state(false);

	const height = new SpringValue(FACE_H);
	const span = $derived(Math.max(1, sheetH - FACE_H));
	const progress = $derived(Math.min(1, Math.max(0, (height.current - FACE_H) / span)));
	const radius = $derived(R_CLOSED + (R_OPEN - R_CLOSED) * progress);

	function close() {
		open = false;
	}

	$effect.pre(() => {
		if (open) rendered = true;
	});

	$effect(() => {
		const target = open ? sheetH : FACE_H;
		untrack(() => height.to(target, 'morph', { settle: !open, instant: !functionalMotion() }));
	});

	$effect(() => {
		if (!open && height.current <= FACE_H + 0.5) rendered = false;
	});

	$effect(() => {
		const el = sheet;
		if (!el) return;
		const measure = () => (sheetH = Math.max(FACE_H, el.offsetHeight));
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		measure();
		return () => ro.disconnect();
	});
</script>

<div class="slot" style:height="{height.current}px">
	<div class="island island--{tone}" class:island--raised={rendered} style:--island-r="{radius}px">
		<button
			type="button"
			class="face"
			class:face--away={open}
			aria-expanded={open}
			aria-controls="{id}-sheet"
			aria-label={label}
			tabindex={open ? -1 : 0}
			onclick={() => (open = true)}
			onkeydown={(e) => {
				if (e.key === 'Escape') open = false;
			}}
		>
			{@render face()}
		</button>
		{#if rendered}
			<div
				class="sheet"
				class:sheet--out={!open}
				id="{id}-sheet"
				role="group"
				aria-label={label}
				bind:this={sheet}
			>
				{@render children({ close })}
			</div>
		{/if}
	</div>
</div>

<style>
	.slot {
		position: relative;
		flex-shrink: 0;
	}
	.island {
		--island-fg: var(--text-default);
		--island-muted: var(--text-muted);
		--island-faint: var(--text-faint);
		--island-rule: var(--border-default);
		--island-ok: var(--status-success);
		--island-tone: var(--text-default);
		position: absolute;
		inset: 0;
		overflow: clip;
		border-radius: calc(var(--island-r) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		color: var(--island-fg);
		box-shadow:
			inset 0 0 0 0.5px var(--border-strong),
			0 1px 2px color-mix(in oklab, var(--neutral-10) 6%, transparent);
	}
	.island--warn {
		--island-tone: var(--status-warning);
	}
	.island--bad {
		--island-tone: var(--status-error);
	}
	.island--raised {
		box-shadow:
			inset 0 0 0 0.5px var(--border-strong),
			var(--shadow-raised);
	}
	.face {
		position: absolute;
		inset: 0 0 auto;
		display: flex;
		align-items: center;
		gap: 0.625rem;
		height: 2.25rem;
		padding: 0 0.875rem 0 0.75rem;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition:
			opacity var(--fade-out) var(--curve-in),
			filter var(--fade-out) var(--curve-in);
	}
	.face:hover {
		background: color-mix(in oklab, var(--neutral-10) 4%, transparent);
	}
	.face:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
		border-radius: inherit;
	}
	.face--away {
		opacity: 0;
		filter: blur(6px);
		pointer-events: none;
	}
	.sheet {
		position: relative;
		padding: 0.75rem 1rem 1rem;
		animation: sheet-in var(--fade-long) var(--curve-out) 80ms both;
	}
	.sheet--out {
		animation: sheet-out var(--fade-out) var(--curve-in) forwards;
		pointer-events: none;
	}
	@keyframes sheet-in {
		from {
			opacity: 0;
			filter: blur(6px);
			transform: scale(0.97);
		}
	}
	@keyframes sheet-out {
		to {
			opacity: 0;
			filter: blur(6px);
			transform: scale(0.97);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.sheet,
		.sheet--out {
			animation: none;
		}
		.face {
			transition: none;
		}
	}
</style>
