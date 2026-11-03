<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { apiBase, apiFetch } from '$lib/stores';
	import { Button } from '$lib/components/ui';
	import { rememberReturnTo } from '$lib/utils/url-secrets';
	import ProviderIcon, { hasProviderMark } from './ProviderIcon.svelte';
	import type { LoginProvider } from './types';

	let {
		returnTo,
		onleave,
		children
	}: {
		returnTo: string;
		onleave?: () => void;
		children?: Snippet<[boolean]>;
	} = $props();

	let providers = $state<LoginProvider[]>([]);
	let loaded = $state(false);
	let starting = $state<string | null>(null);

	const quietFallback = $derived(providers.length > 0 || Boolean(children));

	onMount(async () => {
		try {
			const res = await apiFetch('/apiv1/sso/providers');
			if (res.ok) providers = await res.json();
		} catch {
			providers = [];
		} finally {
			loaded = true;
		}
	});

	function leave() {
		rememberReturnTo(returnTo);
		onleave?.();
	}

	function startProvider(provider: LoginProvider) {
		starting = provider.id;
		leave();
		window.location.href = new URL(
			`${$apiBase}${provider.startUrl}`,
			window.location.origin
		).toString();
	}

	function openLoginPage() {
		leave();
		goto('/');
	}
</script>

{#if loaded}
	{#each providers as provider, i (provider.id)}
		<Button
			variant={i === 0 ? 'primary' : 'secondary'}
			class="w-full"
			loading={starting === provider.id}
			onclick={() => startProvider(provider)}
		>
			{#if starting !== provider.id && hasProviderMark(provider.preset, provider.iconUrl)}
				<ProviderIcon preset={provider.preset} iconUrl={provider.iconUrl} size={16} />
			{/if}
			{provider.label}
		</Button>
	{/each}
	{@render children?.(providers.length > 0)}
	<Button variant={quietFallback ? 'ghost' : 'primary'} class="w-full" onclick={openLoginPage}>
		{quietFallback ? 'Sign in another way' : 'Sign in'}
	</Button>
{:else}
	<Button variant="primary" class="w-full" loading disabled>Sign in</Button>
{/if}
