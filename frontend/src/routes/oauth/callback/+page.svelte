<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import { user } from '$lib/stores';
	import { Loader2, AlertCircle, Lock } from 'lucide-svelte';

	let error = $state<string | null>(null);
	let isPrivateBeta = $state(false);

	onMount(async () => {
		// Check for error in URL params
		const errorParam = $page.url.searchParams.get('error');
		if (errorParam) {
			if (errorParam === 'private_beta') {
				isPrivateBeta = true;
			} else {
				error = errorParam;
			}
			return;
		}

		// Fetch user data
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

			// Redirect to appropriate page
			goto(redirectTo);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Authentication failed';
		}
	});
</script>

<div class="flex min-h-screen items-center justify-center" style="background-color: var(--center-channel-bg);">
	<div class="text-center">
		<img src="/logo/logoiconcolor.svg" alt="Orchard" class="mx-auto mb-6 h-12 w-12" />
		{#if isPrivateBeta}
			<div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full" style="background-color: var(--control-bg);">
				<Lock class="h-6 w-6" style="color: var(--surface-muted);" />
			</div>
			<h1 class="mb-2 text-xl font-semibold" style="color: var(--center-channel-color);">
				Private Beta
			</h1>
			<p class="mb-4" style="color: var(--surface-muted);">Orchard is currently in private beta. You need an invitation from an existing organization to access the platform.</p>
			<a href="/" class="btn btn-primary">
				Return Home
			</a>
		{:else if error}
			<div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
				<AlertCircle class="h-6 w-6 text-red-600 dark:text-red-400" />
			</div>
			<h1 class="mb-2 text-xl font-semibold" style="color: var(--center-channel-color);">
				Authentication Error
			</h1>
			<p class="mb-4" style="color: var(--surface-muted);">{error}</p>
			<a href="/" class="btn btn-primary">
				Return Home
			</a>
		{:else}
			<Loader2 class="mx-auto h-8 w-8 animate-spin text-primary-600" />
			<p class="mt-4" style="color: var(--surface-muted);">
				Completing sign in...
			</p>
		{/if}
	</div>
</div>
