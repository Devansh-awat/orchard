<script lang="ts" generics="T extends string">
	import { untrack, type Snippet } from 'svelte';
	import { animate } from 'motion';
	import { ArrowLeft } from 'lucide-svelte';
	import { Modal } from '$lib/components/ui';
	import { motion, motionEnabled, transition } from '$lib/utils/motion.svelte';
	import { sheetScrollEdges } from './sheet';
	import type { StepStack } from './steps.svelte';

	let {
		open = $bindable(false),
		steps,
		title,
		caption = undefined,
		size = 'md',
		onenter = undefined,
		children,
		footer = undefined
	}: {
		open?: boolean;
		steps: StepStack<T>;
		title: string;
		caption?: string;
		size?: 'sm' | 'md' | 'lg';
		onenter?: () => void;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	const SLIDE = 24;

	let titleEl = $state<HTMLElement | null>(null);

	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) untrack(() => steps.reset());
		wasOpen = open;
	});

	function enter(node: HTMLElement) {
		const moved = untrack(() => steps.moves > 0);
		if (!moved) return;
		const dir = untrack(() => steps.dir);
		node.classList.add('motion-entering');
		const run = motion(node, { opacity: [0, 1], x: [dir * SLIDE, 0] }, 'smooth');
		if (run) run.finished.then(() => node.classList.remove('motion-entering'));
		else node.classList.remove('motion-entering');
		requestAnimationFrame(() => {
			const field = node.querySelector<HTMLElement>('[data-autofocus]');
			(field ?? titleEl)?.focus({ preventScroll: true });
		});
	}

	function fadeTitle(node: HTMLElement) {
		if (!untrack(() => steps.moves > 0)) return;
		motion(node, { opacity: [0, 1] }, 'smooth');
	}

	function autoHeight(viewport: HTMLElement) {
		const inner = viewport.firstElementChild as HTMLElement | null;
		if (!inner) return;
		let shown = inner.offsetHeight;
		let run: ReturnType<typeof animate> | null = null;
		const settle = () => {
			viewport.style.height = '';
			viewport.style.overflow = '';
			run = null;
		};
		const observer = new ResizeObserver(() => {
			const next = inner.offsetHeight;
			if (next === shown && !run) return;
			const from = run ? parseFloat(viewport.style.height) || shown : shown;
			run?.stop();
			shown = next;
			if (!motionEnabled() || Math.abs(next - from) < 1) {
				settle();
				return;
			}
			viewport.style.overflow = 'hidden';
			viewport.style.height = `${from}px`;
			const mine = animate(from, next, {
				...(transition('smooth', { distance: Math.abs(next - from) }) as object),
				onUpdate: (v: number) => {
					viewport.style.height = `${Math.max(0, v)}px`;
				}
			});
			run = mine;
			mine.finished.then(() => {
				if (run === mine) settle();
			});
		});
		observer.observe(inner);
		return () => {
			observer.disconnect();
			run?.stop();
			settle();
		};
	}

	function keys(node: HTMLElement) {
		const dialog = node.closest('dialog');
		if (!dialog) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.defaultPrevented || e.isComposing) return;
			if (dialog.querySelector(':popover-open')) return;
			if (e.key === 'Escape') {
				if (!steps.back()) return;
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (e.key !== 'Enter' || !onenter) return;
			const target = e.target as HTMLElement;
			if (target instanceof HTMLTextAreaElement) {
				if (!(e.metaKey || e.ctrlKey)) return;
			} else if (target.closest('button, a, select, [role="menuitem"], [role="option"]')) {
				return;
			}
			e.preventDefault();
			onenter();
		};
		dialog.addEventListener('keydown', onKey);
		return () => dialog.removeEventListener('keydown', onKey);
	}
</script>

<Modal bind:open {size} {footer}>
	{#snippet header()}
		<div class="head">
			{#if steps.depth > 0}
				<button
					type="button"
					class="gh-ibtn back"
					aria-label="Back"
					title="Back (Esc)"
					onclick={() => steps.back()}
				>
					<ArrowLeft size={16} strokeWidth={1.75} />
				</button>
			{/if}
			{#key steps.current}
				<div class="titles" {@attach fadeTitle}>
					<h2 class="ui-modal-title" tabindex="-1" bind:this={titleEl}>{title}</h2>
					{#if caption}<p class="caption">{caption}</p>{/if}
				</div>
			{/key}
		</div>
	{/snippet}
	<div class="viewport" {@attach autoHeight} {@attach keys}>
		<div class="inner" {@attach sheetScrollEdges}>
			{#key steps.current}
				<div class="step" {@attach enter}>
					{@render children()}
				</div>
			{/key}
		</div>
	</div>
</Modal>

<style>
	.head {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
	}

	.back {
		margin: -0.25rem 0 -0.25rem calc(-1 * var(--gh-ibtn-inset));
	}

	.titles {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}

	.titles h2 {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		outline: none;
	}

	.caption {
		margin: 0;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-muted);
	}

	.inner {
		display: flex;
		flex-direction: column;
	}

	.step {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
</style>
