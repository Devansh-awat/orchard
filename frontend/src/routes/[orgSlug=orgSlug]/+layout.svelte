<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { organizations, selectedOrganization } from '$lib/stores';

	let { children } = $props();

	const orgSlug = $derived($page.params.orgSlug);

	$effect(() => {
		const orgs = $organizations;
		const org = orgs.find((o: { slug: string }) => o.slug === orgSlug);
		if (org) {
			if ($selectedOrganization?.id !== org.id) {
				organizations.setSelected(org);
			}
		} else if (orgs.length > 0) {
			goto('/', { replaceState: true });
		}
	});
</script>

{@render children()}
