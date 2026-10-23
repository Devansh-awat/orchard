<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { Check, CircleAlert, TriangleAlert, Info } from 'lucide-svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import { SpringValue } from '$lib/utils/motion.svelte';
	import { toasts, TOAST_DURATION, type Toast } from '$lib/stores/toast';

	let {
		toast,
		expand,
		align,
		stackHovered
	}: {
		toast: Toast;
		expand: 'top' | 'bottom';
		align: 'left' | 'center' | 'right';
		stackHovered: boolean;
	} = $props();

	const H = 40;
	const ROUND = 16;
	const BLUR = ROUND * 0.5;
	const PILL_PAD = 10;
	const MIN_OPEN = H * 2.25;
	const SWIPE_MAX = 20;
	const SWIPE_DISMISS = 30;

	const ICONS = { success: Check, error: CircleAlert, warning: TriangleAlert, info: Info };

	const uid = $props.id();
	let width = $state(350);
	let ready = $state(false);
	let hovered = $state(false);
	let auto = $state(false);
	let contentH = $state(0);
	let inner = $state<HTMLElement>();
	let content = $state<HTMLElement>();
	let drag = $state(0);
	let dragging = $state(false);

	const progress = new SpringValue(0);
	const pill = new SpringValue(H);

	type Layer = { key: string; title: string; color: Toast['color'] };
	let current = $state<Layer>({ key: '', title: '', color: 'info' });
	let previous = $state<Layer | null>(null);

	const hasMore = $derived(!!(toast.description || toast.action));
	const loading = $derived(toast.color === 'loading');
	const open = $derived(
		hasMore && !loading && !toast.exiting && (hovered || (auto && !stackHovered))
	);

	const openH = $derived(Math.max(MIN_OPEN, H + contentH));
	const p = $derived(progress.current);
	const height = $derived(H + p * (openH - H));
	const pillW = $derived(Math.max(H, pill.current));
	const pillX = $derived(
		align === 'right' ? width - pillW : align === 'center' ? (width - pillW) / 2 : 0
	);
	const svgH = $derived(hasMore ? openH : H);
	const sign = $derived(expand === 'bottom' ? 1 : -1);

	$effect(() => {
		const next = { key: `${toast.color}:${toast.title}`, title: toast.title, color: toast.color };
		untrack(() => {
			if (current.key === next.key) return;
			if (current.key) {
				const outgoing = current;
				previous = outgoing;
				setTimeout(() => {
					if (previous === outgoing) previous = null;
				}, 420);
			}
			current = next;
		});
	});

	$effect(() => {
		const target = open ? 1 : 0;
		untrack(() => progress.to(target, 'morph', { settle: target === 0, instant: !ready }));
	});

	$effect(() => {
		void toast.version;
		if (!hasMore || loading) return;
		const life = toast.duration ?? TOAST_DURATION;
		const expandAt = setTimeout(() => (auto = true), life * 0.025);
		const collapseAt = setTimeout(() => (auto = false), Math.max(life - 2000, life * 0.5));
		return () => {
			clearTimeout(expandAt);
			clearTimeout(collapseAt);
		};
	});

	function measurePill() {
		if (!inner) return;
		pill.to(inner.scrollWidth + 16 + PILL_PAD, 'morph', { instant: !ready });
	}

	$effect(() => {
		if (!inner) return;
		const ro = new ResizeObserver(measurePill);
		ro.observe(inner);
		return () => ro.disconnect();
	});

	$effect(() => {
		if (!content) {
			contentH = 0;
			return;
		}
		const el = content;
		const ro = new ResizeObserver(() => (contentH = el.scrollHeight));
		ro.observe(el);
		return () => ro.disconnect();
	});

	onMount(() => {
		width = Math.min(350, window.innerWidth - 24);
		measurePill();
		const raf = requestAnimationFrame(() => (ready = true));
		return () => cancelAnimationFrame(raf);
	});

	let startY: number | null = null;

	function onpointerdown(e: PointerEvent) {
		if (toast.exiting || (e.target as HTMLElement).closest('button')) return;
		startY = e.clientY;
		dragging = true;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function onpointermove(e: PointerEvent) {
		if (startY === null) return;
		const dy = e.clientY - startY;
		drag = Math.sign(dy) * Math.min(Math.abs(dy), SWIPE_MAX);
	}

	function onpointerup(e: PointerEvent) {
		if (startY === null) return;
		const dy = e.clientY - startY;
		startY = null;
		dragging = false;
		drag = 0;
		if (Math.abs(dy) > SWIPE_DISMISS) toasts.remove(toast.id);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') toasts.remove(toast.id);
	}
</script>

<div
	class="toast"
	data-ready={ready || undefined}
	data-exiting={toast.exiting || undefined}
	data-edge={expand}
	role={toast.color === 'error' ? 'alert' : 'status'}
	tabindex="-1"
	style:--w="{width}px"
	style:--h="{height}px"
	onpointerenter={() => (hovered = true)}
	onpointerleave={() => (hovered = false)}
	{onpointerdown}
	{onpointermove}
	{onpointerup}
	onpointercancel={onpointerup}
	{onkeydown}
>
	<div class="drag" class:drag--live={dragging} style:transform="translateY({drag}px)">
		<div class="canvas" data-edge={expand}>
			<svg {width} height={svgH} viewBox="0 0 {width} {svgH}" aria-hidden="true">
				<defs>
					<filter
						id="goo-{uid}"
						filterUnits="userSpaceOnUse"
						x={-BLUR * 2}
						y={-BLUR * 2}
						width={width + BLUR * 4}
						height={svgH + BLUR * 4}
						color-interpolation-filters="sRGB"
					>
						<feGaussianBlur in="SourceGraphic" stdDeviation={BLUR} result="blur" />
						<feColorMatrix
							in="blur"
							type="matrix"
							values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -10"
							result="goo"
						/>
						<feComposite in="SourceGraphic" in2="goo" operator="atop" />
					</filter>
				</defs>
				<g filter="url(#goo-{uid})">
					<rect class="shape" x={pillX} y="0" width={pillW} height={H + p * BLUR * 3} rx={ROUND} />
					{#if hasMore}
						<rect
							class="shape"
							x="0"
							y={H}
							{width}
							height={Math.max(0, p * (openH - H))}
							rx={ROUND}
							opacity={Math.min(1, p * 3)}
						/>
					{/if}
				</g>
			</svg>
		</div>

		<div
			class="header"
			data-edge={expand}
			style:left="{pillX}px"
			style:max-width="{pillW}px"
			style:transform="translateY({p * 3 * sign}px) scale({1 - p * 0.1})"
		>
			<div class="stack">
				{#key current.key}
					<div class="layer layer--current" bind:this={inner}>
						{@render face(current)}
					</div>
				{/key}
				{#if previous}
					<div class="layer layer--previous" aria-hidden="true">{@render face(previous)}</div>
				{/if}
			</div>
		</div>

		{#if hasMore}
			<div class="content" data-edge={expand} data-visible={open || undefined}>
				<div class="description" bind:this={content}>
					{#if toast.description}<p>{toast.description}</p>{/if}
					{#if toast.action}
						<button
							type="button"
							class="action"
							data-tone={toast.color}
							onclick={() => {
								toast.action?.onClick();
								toasts.remove(toast.id);
							}}>{toast.action.label}</button
						>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</div>

{#snippet face(layer: Layer)}
	<span class="badge" data-tone={layer.color}>
		{#if layer.color === 'loading'}
			<Spinner size={14} />
		{:else}
			{@const Glyph = ICONS[layer.color]}
			<Glyph size={14} strokeWidth={2.5} />
		{/if}
	</span>
	<span class="title" data-tone={layer.color}>{layer.title}</span>
{/snippet}

<style>
	.toast {
		--gap: 0.75rem;
		position: relative;
		width: var(--w);
		height: var(--h);
		flex-shrink: 0;
		pointer-events: auto;
		touch-action: none;
		outline: none;
		opacity: 0;
		transform: translateY(calc(6px * var(--enter-dir))) scale(0.95);
	}
	.toast[data-edge='top'] {
		--enter-dir: 1;
		margin-top: calc(-1 * (var(--h) + var(--gap)));
	}
	.toast[data-edge='bottom'] {
		--enter-dir: -1;
		margin-bottom: calc(-1 * (var(--h) + var(--gap)));
	}
	.toast[data-ready] {
		opacity: 1;
		transform: none;
		margin: 0;
		transition:
			transform var(--spring-morph-duration) var(--spring-morph),
			opacity 220ms ease,
			margin var(--spring-morph-duration) var(--spring-morph);
	}
	.toast[data-ready][data-exiting] {
		opacity: 0;
		transform: translateY(calc(6px * var(--enter-dir))) scale(0.95);
		pointer-events: none;
		transition:
			transform 320ms var(--ease-out),
			opacity 200ms ease,
			margin 380ms var(--ease-out);
	}
	.toast[data-ready][data-exiting][data-edge='top'] {
		margin-top: calc(-1 * (var(--h) + var(--gap)));
	}
	.toast[data-ready][data-exiting][data-edge='bottom'] {
		margin-bottom: calc(-1 * (var(--h) + var(--gap)));
	}

	.drag {
		position: absolute;
		inset: 0;
		transition: transform var(--spring-snappy-duration) var(--spring-snappy);
	}
	.drag--live {
		transition: none;
	}

	.canvas {
		position: absolute;
		right: 0;
		left: 0;
		pointer-events: none;
		filter: drop-shadow(0 6px 16px rgb(0 0 0 / 0.14));
	}
	.canvas[data-edge='bottom'] {
		top: 0;
	}
	.canvas[data-edge='top'] {
		bottom: 0;
		transform: scaleY(-1);
	}
	.canvas svg {
		display: block;
		overflow: visible;
	}
	.shape {
		fill: var(--toast-fill);
	}

	.header {
		position: absolute;
		z-index: 2;
		display: flex;
		align-items: center;
		height: 40px;
		padding: 0.5rem;
		overflow: hidden;
		transform-origin: center;
	}
	.header[data-edge='bottom'] {
		top: 0;
	}
	.header[data-edge='top'] {
		bottom: 0;
	}
	.stack {
		position: relative;
		display: inline-flex;
		align-items: center;
		height: 100%;
	}
	.layer {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		white-space: nowrap;
	}
	.layer--current {
		animation: face-in 420ms var(--spring-smooth) both;
	}
	.layer--previous {
		position: absolute;
		top: 0;
		left: 0;
		height: 100%;
		animation: face-out 300ms ease forwards;
		pointer-events: none;
	}
	@keyframes face-in {
		from {
			opacity: 0;
			filter: blur(6px);
		}
	}
	@keyframes face-out {
		to {
			opacity: 0;
			filter: blur(6px);
		}
	}

	.badge {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		color: var(--tone);
		background: color-mix(in oklab, var(--tone) 22%, transparent);
	}
	.title {
		font-size: 0.8125rem;
		line-height: 1rem;
		font-weight: var(--weight-medium);
		color: var(--tone);
	}
	[data-tone='success'] {
		--tone: var(--toast-success);
	}
	[data-tone='error'] {
		--tone: var(--toast-error);
	}
	[data-tone='warning'] {
		--tone: var(--toast-warning);
	}
	[data-tone='info'] {
		--tone: var(--toast-info);
	}
	[data-tone='loading'] {
		--tone: var(--toast-loading);
	}

	.content {
		position: absolute;
		left: 0;
		z-index: 1;
		width: 100%;
		opacity: 0;
		pointer-events: none;
		transition: opacity 50ms ease 25ms;
	}
	.content[data-edge='bottom'] {
		top: 40px;
	}
	.content[data-edge='top'] {
		top: 0;
	}
	.content[data-visible] {
		opacity: 1;
		pointer-events: auto;
		transition: opacity 360ms ease 180ms;
	}
	.description {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		font-size: var(--text-body);
		line-height: var(--lh-body);
		color: var(--toast-muted);
	}
	.action {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 1.75rem;
		padding: 0 0.625rem;
		border: none;
		border-radius: var(--radius-pill);
		background: color-mix(in oklab, var(--tone) 16%, transparent);
		color: var(--tone);
		font: inherit;
		font-size: var(--text-caption);
		font-weight: var(--weight-medium);
		cursor: pointer;
		transition: background-color var(--dur-fast) ease;
	}
	.action:hover {
		background: color-mix(in oklab, var(--tone) 26%, transparent);
	}
</style>
