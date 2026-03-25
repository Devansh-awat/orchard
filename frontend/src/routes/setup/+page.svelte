<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { user, isSignedIn } from '$lib/stores';
	import { InvitationWelcome } from '$lib/components';

	onMount(() => {
		// If not signed in, go to login
		if (!$isSignedIn) {
			goto('/', { replaceState: true });
			return;
		}

		// If already completed setup, go to dashboard
		if ($user?.setupCompleted) {
			goto('/', { replaceState: true });
		}
	});
</script>

{#if $isSignedIn && $user?.setupCompleted === false}
	<InvitationWelcome />
{/if}
