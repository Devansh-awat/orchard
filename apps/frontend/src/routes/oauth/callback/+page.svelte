<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import { user } from '$lib/stores';
	import { Loader2, AlertCircle, Lock } from 'lucide-svelte';
	import { describeSignInError } from '$lib/components/org-settings/group-rules';

	let error = $state<string | null>(null);
	let isPrivateBeta = $state(false);
	let signupsDisabled = $state(false);

	onMount(async () => {
		const errorParam = $page.url.searchParams.get('error');
		if (errorParam) {
			if (errorParam === 'private_beta' || errorParam === 'signups_disabled') {
				isPrivateBeta = true;
				signupsDisabled = errorParam === 'signups_disabled';
			} else {
				error = describeSignInError(errorParam) ?? errorParam;
			}
			return;
		}

		try {
			await user.fetchUser();

			// Check if there's a stored invite redirect
			let redirectTo = '/';
			if (browser) {
				const inviteRedirect = sessionStorage.getItem('inviteRedirect');
				if (inviteRedirect) {
					sessionStorage.removeItem('inviteRedirect');
					redirectTo = inviteRedirect;
				}
			}

			goto(redirectTo);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Sign-in failed';
		}
	});
</script>

<div
	class="flex min-h-screen items-center justify-center"
	style="background-color: var(--center-channel-bg);"
>
	<div class="text-center">
		<img src="/logo/logoiconcolor.svg" alt="Orchard" class="mx-auto mb-6 h-12 w-12" />
		{#if isPrivateBeta}
			<div
				class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full"
				style="background-color: var(--control-bg);"
			>
				<Lock class="h-6 w-6" style="color: var(--surface-muted);" />
			</div>
			<h1 class="mb-2 text-xl font-semibold" style="color: var(--center-channel-color);">
				{signupsDisabled ? 'Sign-ups closed' : 'Invitation required'}
			</h1>
			<p class="mb-4" style="color: var(--surface-muted);">
				{signupsDisabled
					? "This Orchard instance doesn't allow new accounts. Ask your administrator for access."
					: 'You need an invitation from an organization on this instance.'}
			</p>
			<a href="/" class="btn btn-primary"> Back to sign in </a>
		{:else if error}
			<div
				class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30"
			>
				<AlertCircle class="h-6 w-6 text-red-600 dark:text-red-400" />
			</div>
			<h1 class="mb-2 text-xl font-semibold" style="color: var(--center-channel-color);">
				Sign-in failed
			</h1>
			<p class="mb-4" style="color: var(--surface-muted);">{error}</p>
			<a href="/" class="btn btn-primary"> Back to sign in </a>
		{:else}
			<Loader2 class="mx-auto h-8 w-8 animate-spin text-primary-600" />
			<p class="mt-4" style="color: var(--surface-muted);">Signing you in…</p>
		{/if}
	</div>
</div>
