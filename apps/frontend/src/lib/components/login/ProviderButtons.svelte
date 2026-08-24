<script lang="ts">
	import { Button } from '$lib/components/ui';
	import { apiBase } from '$lib/stores';
	import ProviderIcon from './ProviderIcon.svelte';
	import type { LoginProvider } from './types';

	let {
		providers,
		variant = 'primary',
		returnTo
	}: {
		providers: LoginProvider[];
		variant?: 'primary' | 'secondary';
		returnTo?: string;
	} = $props();

	let starting = $state<string | null>(null);

	function start(provider: LoginProvider) {
		starting = provider.id;
		const url = new URL(`${$apiBase}${provider.startUrl}`, window.location.origin);
		if (returnTo && provider.startUrl.includes('/sso/start/')) {
			url.searchParams.set('returnTo', returnTo);
		}
		window.location.href = url.toString();
	}
</script>

<div class="pv-list">
	{#each providers as provider, i (provider.id)}
		<Button
			variant={i === 0 ? variant : 'secondary'}
			class="lg-wide"
			loading={starting === provider.id}
			onclick={() => start(provider)}
		>
			{#if starting !== provider.id}
				<ProviderIcon preset={provider.preset} />
			{/if}
			{provider.label}
		</Button>
	{/each}
</div>

<style>
	.pv-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: 100%;
	}
</style>
