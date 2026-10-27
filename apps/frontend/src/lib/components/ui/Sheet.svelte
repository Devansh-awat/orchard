<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { X } from 'lucide-svelte';
	import { animate } from 'motion';
	import { decorativeMotion, motionEnabled, transition } from '$lib/utils/motion.svelte';

	let {
		open = $bindable(false),
		title = undefined,
		description = undefined,
		size = 'md',
		dismissable = true,
		onclose = undefined,
		header = undefined,
		children,
		footer = undefined
	}: {
		open?: boolean;
		title?: string;
		description?: string;
		size?: 'sm' | 'md' | 'lg';
		dismissable?: boolean;
		onclose?: () => void;
		header?: Snippet;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	const uid = $props.id();

	let dialogEl = $state<HTMLDialogElement | null>(null);
	let rendered = $state(false);
	let phase: 'out' | 'in' | 'leaving' = 'out';
	let anim: { stop: () => void; finished: Promise<unknown> } | null = null;

	$effect(() => {
		if (open) rendered = true;
	});

	$effect(() => {
		const el = dialogEl;
		const isOpen = open;
		if (!el) return;
		untrack(() => (isOpen ? enter(el) : leave(el)));
	});

	function travel(el: HTMLElement) {
		return el.offsetWidth + 40;
	}

	function focusFirst(el: HTMLElement) {
		const field = el.querySelector<HTMLElement>(
			'[data-sheet-body] :is(input, textarea, select, [contenteditable]):not(:disabled)'
		);
		field?.focus({ preventScroll: true });
	}

	function enter(el: HTMLDialogElement) {
		if (phase === 'in') return;
		const fresh = phase === 'out';
		phase = 'in';
		el.classList.remove('sheet--closing');
		if (!el.open) {
			el.showModal();
			focusFirst(el);
		}
		anim?.stop();
		if (!motionEnabled()) {
			el.style.transform = '';
			el.style.opacity = '';
			return;
		}
		const w = travel(el);
		if (decorativeMotion()) {
			if (fresh) el.style.transform = `translateX(${w}px)`;
			anim = animate(el, { x: fresh ? [w, 0] : 0 }, transition('snap', { distance: w }) as never);
		} else {
			if (fresh) el.style.opacity = '0';
			anim = animate(el, { opacity: fresh ? [0, 1] : 1 }, transition('snap') as never);
		}
	}

	function leave(el: HTMLDialogElement) {
		if (phase !== 'in') return;
		phase = 'leaving';
		el.classList.add('sheet--closing');
		anim?.stop();
		if (!motionEnabled()) {
			finish(el);
			return;
		}
		const w = travel(el);
		anim = decorativeMotion()
			? animate(el, { x: w }, transition('settle', { distance: w }) as never)
			: animate(el, { opacity: 0 }, transition('settle') as never);
		anim.finished.then(() => {
			if (phase === 'leaving') finish(el);
		});
	}

	function finish(el: HTMLDialogElement) {
		phase = 'out';
		anim = null;
		if (el.open) el.close();
		rendered = false;
	}

	function requestClose() {
		if (!open) return;
		open = false;
		onclose?.();
	}

	function handleCancel(e: Event) {
		e.preventDefault();
		if (dismissable) requestClose();
	}

	function handleClick(e: MouseEvent) {
		if (dismissable && e.target === dialogEl) requestClose();
	}
</script>

{#if rendered}
	<dialog
		bind:this={dialogEl}
		class="sheet sheet--{size}"
		aria-labelledby={title ? `${uid}-title` : undefined}
		aria-describedby={description ? `${uid}-desc` : undefined}
		onclick={handleClick}
		oncancel={handleCancel}
		onclose={() => {
			if (open) requestClose();
			phase = 'out';
			rendered = false;
		}}
	>
		<div class="panel">
			<header class="head">
				<div class="title-row">
					{#if header}
						<div class="custom">{@render header()}</div>
					{:else if title}
						<h2 class="title" id="{uid}-title">{title}</h2>
					{/if}
					<button type="button" class="close" aria-label="Close" onclick={requestClose}>
						<X size={16} />
					</button>
				</div>
				{#if description}<p class="desc" id="{uid}-desc">{description}</p>{/if}
			</header>
			<div class="body" data-sheet-body>
				{@render children()}
			</div>
			{#if footer}
				<footer class="foot">{@render footer()}</footer>
			{/if}
		</div>
	</dialog>
{/if}

<style>
	.sheet {
		position: fixed;
		inset: 0.5rem 0.5rem 0.5rem auto;
		width: min(calc(100vw - 1rem), 28rem);
		height: auto;
		max-width: none;
		max-height: none;
		margin: 0;
		padding: 0;
		border: none;
		border-radius: calc(var(--radius-panel) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-raised);
		color: var(--text-default);
		box-shadow: var(--shadow-overlay);
		overflow: hidden;
	}
	.sheet--sm {
		width: min(calc(100vw - 1rem), 24rem);
	}
	.sheet--lg {
		width: min(calc(100vw - 1rem), 36rem);
	}
	.sheet::backdrop {
		background: color-mix(in oklab, black 22%, transparent);
		opacity: 1;
		transition: opacity var(--fade-long) var(--curve-out);
	}
	:global(:root.dark) .sheet::backdrop {
		background: color-mix(in oklab, black 45%, transparent);
	}
	@starting-style {
		.sheet[open]::backdrop {
			opacity: 0;
		}
	}
	:global(.sheet--closing).sheet::backdrop {
		opacity: 0;
		transition: opacity var(--fade-long) var(--curve-in);
	}
	.sheet:focus-visible {
		outline: none;
	}
	.panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.head {
		flex-shrink: 0;
		padding: 0.5rem 0.5rem 1rem 1.25rem;
	}
	.title-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 2rem;
	}
	.custom {
		flex: 1;
		min-width: 0;
	}
	.title {
		flex: 1;
		min-width: 0;
		font-size: var(--text-title-3);
		line-height: var(--lh-title-3);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--track-title);
		color: var(--text-default);
		text-box: trim-both cap alphabetic;
	}
	.desc {
		margin-top: 0.375rem;
		padding-right: 0.75rem;
		font-size: var(--text-callout);
		line-height: 1.25rem;
		color: var(--text-muted);
		text-wrap: pretty;
	}
	.close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 2rem;
		height: 2rem;
		margin-left: auto;
		border: none;
		border-radius: calc(var(--radius-panel) - 0.5rem);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-fast) ease,
			color var(--dur-fast) ease,
			transform var(--spring-press-duration) var(--spring-press);
	}
	.close:hover {
		background: color-mix(in oklab, var(--neutral-10) 7%, transparent);
		color: var(--text-default);
	}
	.close:active {
		transform: scale(0.94);
	}
	.close:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px var(--focus-ring);
	}
	.body {
		flex: 1 1 auto;
		min-height: 0;
		padding: 0.25rem 1.25rem 1.5rem;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.foot {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 0.75rem 1.25rem;
		box-shadow: inset 0 1px 0 var(--border-default);
	}
</style>
