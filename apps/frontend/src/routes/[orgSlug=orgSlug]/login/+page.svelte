<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { Lock } from 'lucide-svelte';
	import { RemoteImg } from '$lib/components/ui';
	import AuthShell from '$lib/components/patterns/AuthShell.svelte';
	import { SignInFlow } from '$lib/components/login';
	import {
		user,
		isSignedIn,
		apiFetch,
		organizations,
		toasts,
		pendingInvitations
	} from '$lib/stores';
	import type { User } from '$lib/stores';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const context = $derived(data.context);
	const branding = $derived(context.branding);
	const returnTo = $derived(`/${context.slug}`);

	let error = $state<string | null>(null);
	let bloom = $state(false);

	onMount(() => {
		const urlError = $page.url.searchParams.get('error');
		if (urlError) error = describeError(urlError);
		if ($isSignedIn) goto(returnTo, { replaceState: true });
	});

	function describeError(code: string) {
		if (code === 'sso_failed') return 'Your identity provider did not finish signing you in.';
		if (code === 'private_beta') return 'This Orchard instance is invite-only.';
		if (code === 'signups_disabled') return 'This Orchard instance is not taking new accounts.';
		return decodeURIComponent(code);
	}

	async function handleAuthenticated(message: string, signedInUser?: User, settle?: Promise<void>) {
		if (signedInUser) user.set(signedInUser);
		await user.fetchUser();
		if (!get(isSignedIn)) return;
		const response = await apiFetch('/apiv1/organizations/user').catch(() => null);
		if (response?.ok) {
			organizations.set(await response.json());
			organizations.initializeSelected();
		}
		await pendingInvitations.fetchPending().catch(() => []);
		await settle;
		toasts.add({ title: message, color: 'success' });
		await goto(returnTo, { replaceState: true });
	}
</script>

<svelte:head>
	<title>Sign in to {context.name}</title>
</svelte:head>

{#snippet enforcedNote()}
	<p class="enforced"><Lock size={13} /> {context.name} requires single sign-on</p>
{/snippet}

<AuthShell {bloom} brand={branding.primaryColor} ground={branding.bgColor}>
	<SignInFlow
		title={branding.welcomeText || `Sign in to ${context.name}`}
		subtitle={branding.tagline || undefined}
		providers={context.providers}
		emailAccess={context.enforced ? 'none' : 'tucked'}
		{returnTo}
		{error}
		bind:bloom
		onAuthenticated={handleAuthenticated}
		aside={context.enforced ? enforcedNote : undefined}
	>
		{#snippet mark()}
			{#if branding.logoUrl || context.avatarUrl}
				<RemoteImg
					src={branding.logoUrl || context.avatarUrl}
					alt={context.name}
					class="org-mark"
				/>
			{:else}
				<span class="org-mark org-mark--letter" aria-hidden="true">{context.name.slice(0, 1)}</span>
			{/if}
		{/snippet}
	</SignInFlow>
	{#snippet footer()}
		Not part of {context.name}? <a href="/">Sign in to Orchard</a>
	{/snippet}
</AuthShell>

<style>
	:global(.org-mark) {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		overflow: hidden;
		border-radius: calc(0.625rem * var(--corner-scale));
		corner-shape: var(--corner);
		object-fit: cover;
		box-shadow: 0 0 0 0.5px var(--rule);
	}
	.org-mark--letter {
		background: color-mix(in oklab, var(--accent-solid) 14%, transparent);
		color: var(--accent-9);
		font-size: var(--text-title-3);
		font-weight: var(--weight-semibold);
		text-transform: uppercase;
	}
	.enforced {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		margin: 0;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}
</style>
