<script lang="ts">
	import { Popover } from 'melt/builders';
	import { PlacementLock } from './placement-lock.svelte';
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

	const lock = new PlacementLock(
		() => placement,
		() => open
	);

	const popover = new Popover({
		open: () => open,
		onOpenChange: (v) => (open = v),
		sameWidth: false,
		floatingConfig: () => lock.config()
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
	{@attach lock.attach}
	{...rest}
	style={[popover.content.style, rest.style].filter(Boolean).join('; ')}
	class="ui-popover{sameWidth ? ' ui-popover--match' : ''}{className ? ` ${className}` : ''}"
	{@attach overlayMotion(() => open, { origin })}
>
	<div class="ui-float-body">{@render children({ close: () => (open = false) })}</div>
</div>
