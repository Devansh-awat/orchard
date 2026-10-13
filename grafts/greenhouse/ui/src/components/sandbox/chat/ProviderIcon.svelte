<script lang="ts">
	import { Cpu } from 'lucide-svelte';
	import type { OcProviderKind } from '../opencode';
	import { PROVIDER_ICON_LABELS, PROVIDER_ICON_PATHS } from './provider-icons';

	let { kind, size = 14 }: { kind: OcProviderKind; size?: number } = $props();
</script>

<span
	class="pi pi--{kind}"
	style="width: {size}px; height: {size}px"
	role="img"
	aria-label={PROVIDER_ICON_LABELS[kind]}
>
	{#if kind === 'other'}
		<Cpu {size} strokeWidth={1.75} aria-hidden="true" />
	{:else}
		<svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
			<path d={PROVIDER_ICON_PATHS[kind]} fill="currentColor" />
		</svg>
	{/if}
</span>

<style>
	.pi {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.pi--anthropic {
		color: color-mix(in oklab, var(--hue-red) 45%, var(--hue-amber));
	}

	.pi--openai {
		color: var(--text-default);
	}

	.pi--other {
		color: var(--text-muted);
	}
</style>
