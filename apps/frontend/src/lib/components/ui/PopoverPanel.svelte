<script lang="ts">
	import { Popover } from 'melt/builders';
	import type { Snippet } from 'svelte';
	import type { Placement } from '@floating-ui/dom';
	import { overlayMotion } from '$lib/utils/motion.svelte';

	let {
		placement = 'bottom-start',
		open = $bindable(false),
		sameWidth = false,
		class: className = '',
		trigger,
		children,
		...rest
	}: {
		placement?: Placement;
		open?: boolean;
		sameWidth?: boolean;
		class?: string;
		trigger: Snippet<[Record<string, unknown>, boolean]>;
		children: Snippet<[{ close: () => void }]>;
		[key: string]: unknown;
	} = $props();

	const popover = new Popover({
		open: () => open,
		onOpenChange: (v) => (open = v),
		sameWidth: () => sameWidth,
		floatingConfig: {
			computePosition: { placement },
			offset: { mainAxis: 6 }
		}
	});

	const origin = $derived.by(() => {
		const [side, align] = placement.split('-');
		if (side === 'left' || side === 'right') {
			const x = side === 'left' ? 'right' : 'left';
			return `${x} ${align === 'start' ? 'top' : align === 'end' ? 'bottom' : 'center'}`;
		}
		const y = side === 'top' ? 'bottom' : 'top';
		return `${align === 'start' ? 'left' : align === 'end' ? 'right' : 'center'} ${y}`;
	});
</script>

{@render trigger(popover.trigger, open)}
<div
	{...popover.content}
	{...rest}
	class="ui-popover{className ? ` ${className}` : ''}"
	{@attach overlayMotion(() => open, { origin })}
>
	{@render children({ close: () => (open = false) })}
</div>
