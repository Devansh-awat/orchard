<script lang="ts">
	import { Popover } from 'melt/builders';
	import type { Snippet } from 'svelte';
	import type { Placement } from '@floating-ui/dom';

	let {
		placement = 'bottom-start',
		open = $bindable(false),
		sameWidth = false,
		trigger,
		children
	}: {
		placement?: Placement;
		open?: boolean;
		sameWidth?: boolean;
		trigger: Snippet<[Record<string, unknown>, boolean]>;
		children: Snippet<[{ close: () => void }]>;
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
</script>

{@render trigger(popover.trigger, open)}
<div {...popover.content} class="ui-popover">
	{@render children({ close: () => (open = false) })}
</div>
