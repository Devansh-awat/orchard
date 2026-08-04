<script lang="ts">
	import { Popover } from 'melt/builders';
	import { setContext, type Snippet } from 'svelte';
	import type { Placement } from '@floating-ui/dom';
	import { overlayMotion } from '$lib/utils/motion.svelte';

	let {
		placement = 'bottom-end',
		open = $bindable(false),
		trigger,
		children
	}: {
		placement?: Placement;
		open?: boolean;
		trigger: Snippet<[Record<string, unknown>, boolean]>;
		children: Snippet;
	} = $props();

	const popover = new Popover({
		open: () => open,
		onOpenChange: (v) => (open = v),
		floatingConfig: {
			computePosition: { placement },
			offset: { mainAxis: 6 }
		}
	});

	setContext('ui-menu', {
		close: () => {
			open = false;
		}
	});
</script>

{@render trigger(popover.trigger, open)}
<!-- The panel renders in the top layer but keeps its DOM position, so clicks
     inside it bubble to whatever hosts the trigger (e.g. an expandable card
     header). Stop them at the panel boundary so host handlers can't hijack
     item clicks or cancel link navigation. -->
<div
	{...popover.content}
	class="ui-menu"
	role="menu"
	onclick={(e: MouseEvent) => e.stopPropagation()}
	{@attach overlayMotion(() => open, {
		origin: `${placement.startsWith('top') ? 'bottom' : 'top'} ${placement.endsWith('end') ? 'right' : 'left'}`
	})}
>
	{@render children()}
</div>
