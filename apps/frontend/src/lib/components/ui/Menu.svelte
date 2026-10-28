<script lang="ts">
	import { Popover } from 'melt/builders';
	import { PlacementLock } from './placement-lock.svelte';
	import { setContext, type Snippet } from 'svelte';
	import type { Placement } from '@floating-ui/dom';
	import { overlayMotion } from '$lib/utils/motion.svelte';

	let {
		placement = 'bottom-end',
		open = $bindable(false),
		sameWidth = false,
		size = 'md',
		width = undefined,
		inside,
		trigger,
		children
	}: {
		placement?: Placement;
		open?: boolean;
		sameWidth?: boolean;
		size?: 'md' | 'lg';
		width?: number;
		inside?: (target: Element | Window | Document) => boolean;
		trigger: Snippet<[Record<string, unknown>, boolean]>;
		children: Snippet;
	} = $props();

	const lock = new PlacementLock(
		() => placement,
		() => open
	);

	const popover = new Popover({
		open: () => open,
		onOpenChange: (v) => (open = v),
		sameWidth: false,
		closeOnOutsideClick: (target: Element | Window | Document) => !inside?.(target),
		floatingConfig: () => lock.config()
	});

	let opened = $state(false);
	let nav = $state<'keys' | 'pointer'>('pointer');

	$effect.pre(() => {
		if (open) opened = true;
	});

	setContext('ui-menu', {
		close: () => {
			open = false;
		}
	});

	const ITEM = '[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])';

	function items(panel: HTMLElement) {
		return [...panel.querySelectorAll<HTMLElement>(ITEM)];
	}

	function onkeydown(e: KeyboardEvent) {
		if ((e.target as HTMLElement).closest('input, textarea, select')) return;
		const panel = e.currentTarget as HTMLElement;
		const list = items(panel);
		if (list.length === 0) return;
		const at = list.indexOf(document.activeElement as HTMLElement);
		let next = -1;
		if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % list.length;
		else if (e.key === 'ArrowUp')
			next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = list.length - 1;
		else if (e.key.length === 1 && /\S/.test(e.key)) {
			const key = e.key.toLowerCase();
			const order = [...list.slice(at + 1), ...list.slice(0, at + 1)];
			const hit = order.find((el) => el.textContent?.trim().toLowerCase().startsWith(key));
			if (hit) next = list.indexOf(hit);
		}
		if (next < 0) return;
		e.preventDefault();
		nav = 'keys';
		list[next].focus({ preventScroll: false });
	}

	function onpointermove(e: PointerEvent) {
		nav = 'pointer';
		const item = (e.target as Element).closest<HTMLElement>(ITEM);
		if (item && document.activeElement !== item) item.focus({ preventScroll: true });
	}

	function onpointerleave(e: PointerEvent) {
		const panel = e.currentTarget as HTMLElement;
		if (panel.contains(document.activeElement) && document.activeElement !== panel) {
			panel.focus({ preventScroll: true });
		}
	}
</script>

{@render trigger(popover.trigger, open)}
<div
	{...popover.content}
	{@attach lock.attach}
	class="ui-menu ui-menu--{size}"
	class:ui-popover--match={sameWidth && !width}
	style:width={width ? `${width}px` : undefined}
	style:min-width={width ? '0' : undefined}
	role="menu"
	data-nav={nav}
	onclick={(e: MouseEvent) => e.stopPropagation()}
	{onkeydown}
	{onpointermove}
	{onpointerleave}
	{@attach overlayMotion(() => open, {
		origin: `${placement.startsWith('top') ? 'bottom' : 'top'} ${placement.endsWith('end') ? 'right' : 'left'}`
	})}
>
	<div class="ui-float-body">
		{#if open || opened}
			{@render children()}
		{/if}
	</div>
</div>
