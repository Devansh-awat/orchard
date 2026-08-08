<script lang="ts">
	import { page } from '$app/stores';
	import { organizations, selectedOrganization, isSignedIn } from '$lib/stores';
	import ErrorPage from '$lib/components/ErrorPage.svelte';
	import EngineBanner from '$lib/components/EngineBanner.svelte';

	let { children } = $props();

	const orgSlug = $derived($page.params.orgSlug);
	let notFound = $state(false);

	$effect(() => {
		const orgs = $organizations;
		const signedIn = $isSignedIn;
		const org = orgs.find((o: { slug: string }) => o.slug === orgSlug);
		if (org) {
			notFound = false;
			if ($selectedOrganization?.id !== org.id) {
				organizations.setSelected(org);
			}
		} else if (orgs.length > 0 || !signedIn) {
			notFound = true;
		}
	});
</script>

{#if notFound}
	<ErrorPage status={404} />
{:else}
	<EngineBanner />
	{@render children()}
{/if}
