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
		{@attach springHover({ lift: -1, stiffness: 400, damping: 26 })}
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
		gap: 1rem;
		padding: 0.75rem 1rem;
		border-radius: 0.625rem;
		background-color: color-mix(in srgb, var(--center-channel-color) 2%, transparent);
	}
	.ic-info {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--center-channel-color);
	}
	.ic-icon {
		display: flex;
		align-items: center;
		color: var(--surface-muted);
	}
	.ic-name {
		font-size: 0.875rem;
		font-weight: 550;
		font-family: var(--font-mono);
	}
	.ic-disconnect {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 550;
		border: none;
		cursor: pointer;
		transition: all 120ms;
		white-space: nowrap;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
	}
	.ic-disconnect:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--error-text-color) 16%, transparent);
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
