<script lang="ts">
	import { page } from '$app/stores';
	import { CheckCircle2, AlertCircle } from 'lucide-svelte';

	let errorParam = $derived($page.url.searchParams.get('error'));
	let ok = $derived(!errorParam);

	let message = $derived.by(() => {
		switch (errorParam) {
			case null:
			case '':
				return 'Your token was sent to the CLI. You can close this tab and return to your terminal.';
			case 'access_denied':
				return "Authorization canceled. Orchard didn't send anything to the CLI.";
			case 'state_mismatch':
				return "Orchard couldn't verify the request, so it didn't send a token. Run the sign-in command again.";
			default:
				return 'Sign-in failed. Run the command again.';
		}
	});
</script>

<svelte:head>
	<title>{ok ? 'Signed in' : 'Sign-in failed'} · Orchard CLI</title>
</svelte:head>

<div
	class="flex min-h-screen items-center justify-center"
	style="background-color: var(--center-channel-bg);"
>
	<div class="text-center" style="max-width: 26rem; padding: 0 1.5rem;">
		<img src="/logo/logoiconcolor.svg" alt="Orchard" class="mx-auto mb-6 h-12 w-12" />
		{#if ok}
			<div
				class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full"
				style="background-color: var(--control-bg);"
			>
				<CheckCircle2 class="h-6 w-6" style="color: var(--online-indicator, #22c55e);" />
			</div>
			<h1 class="mb-2 text-xl font-semibold" style="color: var(--center-channel-color);">
				You're signed in
			</h1>
		{:else}
			<div
				class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30"
			>
				<AlertCircle class="h-6 w-6 text-red-600 dark:text-red-400" />
			</div>
			<h1 class="mb-2 text-xl font-semibold" style="color: var(--center-channel-color);">
				Sign-in failed
			</h1>
		{/if}
		<p class="mb-4" style="color: var(--surface-muted);">{message}</p>
	</div>
</div>
