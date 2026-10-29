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
		children: Snippet;
	} = $props();

	const FACE_H = 36;
	const R_CLOSED = 18;
	const R_OPEN = 22;

	const id = $props.id();
	let root = $state<HTMLElement>();
	let sheet = $state<HTMLElement>();
	let sheetH = $state(0);
	let rendered = $state(false);

	const height = new SpringValue(FACE_H);
	const progress = $derived(
		sheetH > 0 ? Math.min(1, Math.max(0, (height.current - FACE_H) / sheetH)) : 0
	);
	const radius = $derived(R_CLOSED + (R_OPEN - R_CLOSED) * progress);

	$effect.pre(() => {
		if (open) rendered = true;
	});

	$effect(() => {
		const target = open ? FACE_H + sheetH : FACE_H;
		untrack(() => height.to(target, 'morph', { settle: !open, instant: !functionalMotion() }));
	});

	$effect(() => {
		if (!open && height.current <= FACE_H + 0.5) rendered = false;
	});

	$effect(() => {
		const el = sheet;
		if (!el) return;
		const ro = new ResizeObserver(() => (sheetH = el.offsetHeight));
		ro.observe(el);
		sheetH = el.offsetHeight;
		return () => ro.disconnect();
	});

	$effect(() => {
		if (!open) return;
		const away = (e: PointerEvent) => {
			if (root && !root.contains(e.target as Node)) open = false;
		};
		const esc = (e: KeyboardEvent) => {
			if (e.key === 'Escape') open = false;
		};
		document.addEventListener('pointerdown', away, true);
		document.addEventListener('keydown', esc);
		return () => {
			document.removeEventListener('pointerdown', away, true);
			document.removeEventListener('keydown', esc);
		};
	});
</script>

<div class="slot">
	<div
		bind:this={root}
		class="island island--{tone}"
		class:island--open={open}
		class:island--raised={rendered}
		style:height="{height.current}px"
		style:--island-r="{radius}px"
	>
		<button
			type="button"
			class="face"
			aria-expanded={open}
			aria-controls="{id}-sheet"
			aria-label={label}
			onclick={() => (open = !open)}
		>
			{@render face()}
		</button>
		{#if rendered}
			<div class="sheet" class:sheet--out={!open} id="{id}-sheet" bind:this={sheet}>
				{@render children()}
			</div>
		{/if}
	</div>
</div>

<style>
	.slot {
		position: relative;
		height: 2.25rem;
	}
	.island {
		--island-tint: transparent;
		--island-ring: var(--border-strong);
		--island-fg: var(--text-default);
		--island-muted: var(--text-muted);
		--island-faint: var(--text-faint);
		--island-rule: var(--border-default);
		--island-ok: var(--status-success);
		--island-tone: var(--text-default);
		position: absolute;
		inset: 0 0 auto;
		z-index: 1;
		overflow: clip;
		border-radius: calc(var(--island-r) * var(--corner-scale));
		corner-shape: var(--corner);
		background: linear-gradient(var(--island-tint), var(--island-tint)), var(--bg-surface);
		color: var(--island-fg);
		box-shadow:
			inset 0 0 0 0.5px var(--island-ring),
			0 1px 2px color-mix(in oklab, var(--neutral-10) 6%, transparent);
	}
	.island--warn {
		--island-tone: var(--status-warning);
	}
	.island--bad {
		--island-tone: var(--status-error);
	}
	.island--raised {
		z-index: var(--z-dropdown);
		box-shadow:
			inset 0 0 0 0.5px var(--island-ring),
			var(--shadow-floating);
	}
	.face {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		width: 100%;
		height: 2.25rem;
		padding: 0 0.875rem 0 0.75rem;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.face:hover {
		background: color-mix(in oklab, var(--neutral-10) 4%, transparent);
	}
	.face:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
		border-radius: inherit;
	}
	.sheet {
		padding: 0 0.875rem 0.875rem;
		animation: sheet-in var(--fade-long) var(--curve-out) 60ms both;
	}
	.sheet--out {
		animation: sheet-out var(--fade-out) var(--curve-in) forwards;
	}
	@keyframes sheet-in {
		from {
			opacity: 0;
			filter: blur(6px);
		}
	}
	@keyframes sheet-out {
		to {
			opacity: 0;
			filter: blur(6px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.sheet,
		.sheet--out {
			animation: none;
		}
	}
</style>
