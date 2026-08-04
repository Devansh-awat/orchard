<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Loader2 } from 'lucide-svelte';
	import { Unplug } from '@jis3r/icons';
	import { springHover } from '$lib/utils/motion.svelte';

	let {
		name,
		icon,
		disconnecting = false,
		onDisconnect
	}: {
		name: string;
		icon?: Snippet;
		disconnecting?: boolean;
		onDisconnect: () => void;
	} = $props();

	let btnHovered = $state(false);
</script>

<div class="ic-root">
	<div class="ic-info">
		{#if icon}
			<div class="ic-icon">
				{@render icon()}
			</div>
		{/if}
		<span class="ic-name">{name}</span>
	</div>
	<button
		onclick={onDisconnect}
		disabled={disconnecting}
		class="ic-disconnect"
		onmouseenter={() => (btnHovered = true)}
		onmouseleave={() => (btnHovered = false)}
		{@attach springHover({ lift: -1 })}
	>
		{#if disconnecting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<span class="ic-icon-wrap"
				><Unplug size={14} animate={btnHovered} /></span
			>{/if}
		Disconnect
	</button>
</div>

<style>
	.ic-root {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);
		background-color: var(--fill-quiet);
	}
	.ic-info {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--text-default);
	}
	.ic-icon {
		display: flex;
		align-items: center;
		color: var(--text-muted);
	}
	.ic-name {
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: 600;
		font-family: var(--font-mono);
	}
	.ic-disconnect {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.875rem;
		border-radius: var(--radius-sm);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		border: none;
		cursor: pointer;
		transition: background-color var(--dur-fast);
		white-space: nowrap;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--status-error) 10%, transparent);
		color: var(--status-error);
	}
	.ic-disconnect:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--status-error) 16%, transparent);
	}
	.ic-disconnect:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.ic-icon-wrap {
		display: inline-flex;
		pointer-events: none;
	}
	@media (max-width: 640px) {
		.ic-root {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
