<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { Lock } from 'lucide-svelte';
	import { Badge, IconTile } from '$lib/components/ui';
	import Monogram from '$lib/components/ui/Monogram.svelte';
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
	let landed = $state(false);

	onMount(() => {
		const urlError = $page.url.searchParams.get('error');
		if (urlError) error = describeError(urlError);
		if ($isSignedIn) goto(returnTo, { replaceState: true });
	});

	function describeError(code: string) {
		if (code === 'sso_failed') return "Your identity provider didn't finish signing you in.";
		if (code === 'private_beta') return 'This Orchard instance is invite-only.';
		if (code === 'signups_disabled') return "This Orchard instance isn't taking new accounts.";
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
	<Badge><Lock size={12} /> {context.name} requires single sign-on</Badge>
{/snippet}

<AuthShell
	{bloom}
	{landed}
	brand={branding.primaryColor}
	ground={branding.bgColor}
	tagline={branding.tagline}
>
	{#snippet wordmark()}
		<IconTile src={branding.logoUrl || context.avatarUrl} alt="" class="org-mark">
			{#snippet fallback()}<Monogram name={context.name} size="lg" />{/snippet}
		</IconTile>
		<span class="org-name" title={context.name}>{context.name}</span>
	{/snippet}
	{#snippet headline()}
		{#if branding.welcomeText}{branding.welcomeText}{:else}sign in to <em>{context.name}</em>.{/if}
	{/snippet}
	<SignInFlow
		title="Sign in"
		subtitle={$page.url.host}
		providers={context.providers}
		emailAccess={context.enforced ? 'none' : 'tucked'}
		{returnTo}
		{error}
		bind:bloom
		bind:landed
		onAuthenticated={handleAuthenticated}
		aside={context.enforced ? enforcedNote : undefined}
	/>
	{#snippet footer()}
		Not part of {context.name}? <a href="/">Sign in to Orchard</a>
	{/snippet}
</AuthShell>

<style>
	:global(.org-mark) {
		flex-shrink: 0;
		width: 2rem;
		height: 2rem;
		border-radius: calc(0.5rem * var(--corner-scale));
		corner-shape: var(--corner);
	}
	.org-name {
		min-width: 0;
		overflow-x: clip;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-headline);
		font-weight: var(--weight-semibold);
	}
</style>
