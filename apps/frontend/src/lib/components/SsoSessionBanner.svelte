<script lang="ts">
	import { browser } from '$app/environment';
	import { Button } from '$lib/components/ui';
	import Alert from '$lib/components/ui/Alert.svelte';
	import { selectedOrganization, user } from '$lib/stores';

	const orgId = $derived($user?.sessionOrganizationId ?? null);
	const isIdentity = $derived(Boolean($user?.homeOrganizationId));
	const key = $derived(orgId ? `orchard:sso-link-hint:${orgId}` : null);
	let dismissed = $state(false);

	$effect(() => {
		dismissed = Boolean(browser && key && localStorage.getItem(key));
	});

	function dismiss() {
		if (browser && key) localStorage.setItem(key, '1');
		dismissed = true;
	}
</script>

{#if orgId && isIdentity && !dismissed}
	<div class="sso-banner">
		<Alert
			tone="info"
			title="Signed in with {$selectedOrganization?.name ?? 'your organization'} single sign-on"
		>
			Have a personal Orchard account too? Sign in to it and add this organization under Settings,
			Connections, to switch between them in one place.
			{#snippet actions()}
				<Button size="sm" variant="ghost" onclick={dismiss}>Got it</Button>
			{/snippet}
		</Alert>
	</div>
{/if}

<style>
	.sso-banner {
		padding: var(--space-3) var(--space-4) 0;
	}
</style>
