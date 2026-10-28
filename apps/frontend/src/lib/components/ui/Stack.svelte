<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		gap = 'md',
		sticky = false,
		class: className = '',
		children
	}: {
		gap?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
		sticky?: boolean;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<div class="stack stack--{gap} {className}" class:stack--sticky={sticky}>
	{@render children()}
</div>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.stack--xs {
		gap: var(--space-2);
	}
	.stack--sm {
		gap: var(--space-3);
	}
	.stack--md {
		gap: var(--space-4);
	}
	.stack--lg {
		gap: var(--space-6);
	}
	.stack--xl {
		gap: var(--space-10);
	}
	.stack--sticky {
		position: sticky;
		top: var(--space-6);
	}
</style>
