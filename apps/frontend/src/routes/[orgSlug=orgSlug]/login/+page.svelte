<script lang="ts">
	import '$lib/components/login/login.css';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { Lock } from 'lucide-svelte';
	import { Button, RemoteImg } from '$lib/components/ui';
	import { EmailAuthPanel, ProviderButtons } from '$lib/components/login';
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

	let showEmail = $state(false);
	let blocked = $state<'private_beta' | 'signups_disabled' | null>(null);
	let error = $state<string | null>(null);

	const returnTo = $derived(`/${context.slug}`);

	onMount(() => {
		const urlError = $page.url.searchParams.get('error');
		if (urlError) error = describeError(urlError);
		if ($isSignedIn) goto(`/${context.slug}`, { replaceState: true });
	});

	function describeError(code: string) {
		if (code === 'sso_failed') return 'We could not complete sign-in with your identity provider.';
		if (code === 'private_beta') return 'This Orchard instance is invite-only.';
		if (code === 'signups_disabled') return 'Signups are disabled on this Orchard instance.';
		return decodeURIComponent(code);
	}

	async function handleAuthenticated(message: string, signedInUser?: User) {
		if (signedInUser) user.set(signedInUser);
		await user.fetchUser();

		if (get(isSignedIn)) {
			const response = await apiFetch('/apiv1/organizations/user').catch(() => null);
			if (response?.ok) {
				organizations.set(await response.json());
				organizations.initializeSelected();
			}
			await pendingInvitations.fetchPending().catch(() => []);
			toasts.add({ title: message, color: 'success' });
			goto(`/${context.slug}`, { replaceState: true });
		}
	}
</script>

<svelte:head>
	<title>Sign in to {context.name}</title>
</svelte:head>

<div
	class="ol-page"
	style={[
		branding.primaryColor ? `--ol-accent: ${branding.primaryColor};` : '',
		branding.bgColor ? `--ol-bg: ${branding.bgColor};` : ''
	].join(' ')}
>
	<div class="ol-shell">
		<div class="ol-hero">
			{#if branding.logoUrl || context.avatarUrl}
				<RemoteImg src={branding.logoUrl || context.avatarUrl} alt={context.name} class="ol-logo" />
			{:else}
				<span class="ol-monogram" aria-hidden="true">{context.name.slice(0, 1)}</span>
			{/if}
			<h1 class="ol-headline">
				{branding.welcomeText || `Sign in to ${context.name}`}
			</h1>
			{#if branding.tagline}
				<p class="ol-tagline">{branding.tagline}</p>
			{/if}
			{#if context.enforced}
				<p class="ol-enforced">
					<Lock size={13} />
					Single sign-on is required for this organization
				</p>
			{/if}
		</div>

		<div class="lg2-card ol-card">
			{#if blocked}
				<div class="lg-beta">
					<h2 class="lg-beta-title">
						{blocked === 'signups_disabled' ? 'Signups disabled' : 'Private beta'}
					</h2>
					<p class="lg-beta-desc">
						{blocked === 'signups_disabled'
							? 'Signups are disabled on this Orchard instance. Contact your administrator for access.'
							: 'You need an invitation from an existing organization to access this platform.'}
					</p>
					<Button
						variant="primary"
						class="lg-wide"
						onclick={() => {
							blocked = null;
						}}
					>
						Back to sign in
					</Button>
				</div>
			{:else}
				{#if error}
					<p class="lg-error ol-error">{error}</p>
				{/if}

				<ProviderButtons providers={context.providers} {returnTo} />

				{#if !context.enforced}
					<div class="lg-divider"><span>or</span></div>
					{#if showEmail}
						<EmailAuthPanel
							onAuthenticated={handleAuthenticated}
							onBlocked={(reason) => {
								blocked = reason;
							}}
						/>
					{:else}
						<Button
							variant="ghost"
							class="lg-wide"
							onclick={() => {
								showEmail = true;
							}}
						>
							Sign in with email instead
						</Button>
					{/if}
				{/if}

				<p class="ol-footer">
					Not part of {context.name}? <a href="/">Sign in to Orchard</a>
				</p>
			{/if}
		</div>
	</div>
</div>

<style>
	.ol-page {
		--ol-accent: var(--accent);
		--ol-bg: var(--bg-app);
		min-height: 100dvh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 3rem 1.5rem;
		background:
			radial-gradient(
				ellipse 60rem 40rem at 50% -10%,
				color-mix(in srgb, var(--ol-accent) 14%, transparent),
				transparent 70%
			),
			var(--ol-bg);
	}

	.ol-shell {
		width: 100%;
		max-width: 25rem;
		display: flex;
		flex-direction: column;
		gap: 1.75rem;
	}

	.ol-hero {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		text-align: center;
	}

	.ol-shell :global(.ol-logo) {
		width: 3rem;
		height: 3rem;
		border-radius: var(--radius-md);
		object-fit: cover;
	}

	.ol-monogram {
		width: 3rem;
		height: 3rem;
		border-radius: var(--radius-md);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: var(--text-title-3);
		font-weight: 700;
		text-transform: uppercase;
		color: var(--ol-accent);
		background: color-mix(in srgb, var(--ol-accent) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--ol-accent) 24%, transparent);
	}

	.ol-headline {
		font-size: var(--text-title-3);
		line-height: var(--lh-title-3);
		font-weight: 700;
		letter-spacing: -0.02em;
		margin: 0;
		text-wrap: balance;
	}

	.ol-tagline {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
		margin: 0;
		text-wrap: balance;
	}

	.ol-enforced {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
		margin: 0;
	}

	.ol-card {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		--accent: var(--ol-accent);
	}

	/* The primary button's fill is a Tailwind utility, not a token, so an org's
	   brand colour has to be applied here rather than by setting --accent. */
	.ol-card :global(.btn-primary) {
		background: var(--ol-accent);
		border-color: transparent;
	}

	.ol-card :global(.btn-primary:hover) {
		background: color-mix(in srgb, var(--ol-accent) 88%, black);
	}

	.ol-error {
		margin: 0 0 0.25rem;
		text-align: center;
	}

	.ol-footer {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
		text-align: center;
		margin: 0.25rem 0 0;
	}

	.ol-footer a {
		color: var(--text-muted);
		text-decoration: none;
	}

	.ol-footer a:hover {
		color: var(--text-default);
	}
</style>
