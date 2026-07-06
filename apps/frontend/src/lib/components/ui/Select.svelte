<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ChevronDown } from 'lucide-svelte';

	let {
		value = $bindable(''),
		class: className = '',
		children,
		...rest
	}: {
		value?: string;
		class?: string;
		children: Snippet;
		[key: string]: unknown;
	} = $props();
</script>

<div class="ui-select-wrap{className ? ` ${className}` : ''}">
	<select class="ui-select" bind:value {...rest}>
		{@render children()}
	</select>
	<ChevronDown size={14} class="ui-select-chevron" />
</div>
