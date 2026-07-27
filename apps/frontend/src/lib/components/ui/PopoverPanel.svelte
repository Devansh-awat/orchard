<script lang="ts">
	import { Popover } from 'melt/builders';
	import type { Snippet } from 'svelte';
	import type { Placement } from '@floating-ui/dom';

	let {
		placement = 'bottom-start',
		open = $bindable(false),
		sameWidth = false,
		class: className = '',
		trigger,
		children
	}: {
		placement?: Placement;
		open?: boolean;
		sameWidth?: boolean;
		class?: string;
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
<div {...popover.content} class="ui-popover{className ? ` ${className}` : ''}">
	{@render children({ close: () => (open = false) })}
</div>
