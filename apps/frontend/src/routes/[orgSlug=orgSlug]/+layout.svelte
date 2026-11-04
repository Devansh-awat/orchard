<script lang="ts">
	import { page } from '$app/stores';
	import { organizations, selectedOrganization, isSignedIn } from '$lib/stores';
	import ErrorPage from '$lib/components/ErrorPage.svelte';
	import EngineBanner from '$lib/components/EngineBanner.svelte';
	import OrgSsoRequired from '$lib/components/org-settings/OrgSsoRequired.svelte';

	let { children } = $props();

	const orgSlug = $derived($page.params.orgSlug);
	// The org login page is the one route under /<org> that exists for people
	// who are not signed in, so the membership gate below has to sit this out.
	const isLoginRoute = $derived($page.url.pathname === `/${orgSlug}/login`);
	let notFound = $state(false);
	const ssoRequiredOrg = $derived(
		isLoginRoute ? null : $organizations.find((o) => o.slug === orgSlug && o.ssoRequired)
	);

	$effect(() => {
		if (isLoginRoute) {
			notFound = false;
			return;
		}
		const orgs = $organizations;
		const signedIn = $isSignedIn;
		const org = orgs.find((o: { slug: string }) => o.slug === orgSlug);
		if (org?.ssoRequired) {
			notFound = false;
		} else if (org) {
			notFound = false;
			if ($selectedOrganization?.id !== org.id) {
				organizations.setSelected(org);
			}
		} else if (orgs.length > 0 || !signedIn) {
			// Signed out, the root layout is already redirecting to this org's
			// login page; the 404 is for signed-in non-members.
			notFound = signedIn;
		}
	});
</script>

{#if notFound}
	<ErrorPage status={404} />
{:else if ssoRequiredOrg}
	<OrgSsoRequired organization={ssoRequiredOrg} />
{:else if isLoginRoute}
	{@render children()}
{:else}
	<EngineBanner />
	{@render children()}
{/if}
