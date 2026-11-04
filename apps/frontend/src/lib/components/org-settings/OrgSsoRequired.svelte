<script lang="ts">
	import { page } from '$app/stores';
	import { Button, EmptyState } from '$lib/components/ui';
	import { apiFetch } from '$lib/stores';
	import LeaveOrganizationButton from './LeaveOrganizationButton.svelte';

	let { organization }: { organization: { id: string; name: string; slug: string } } = $props();

	let providers = $state<{ id: string; label: string; startUrl: string }[]>([]);

	$effect(() => {
		const slug = organization.slug;
		apiFetch(`/apiv1/sso/org/${encodeURIComponent(slug)}`)
			.then((response) => (response.ok ? response.json() : null))
			.then((context) => (providers = context?.providers ?? []))
			.catch(() => (providers = []));
	});

	const returnTo = $derived(encodeURIComponent($page.url.pathname));
</script>

<div class="org-sso-required">
	<EmptyState
		title={`${organization.name} requires single sign-on`}
		description="Sign in with its identity provider to open this organization. Your other organizations stay available from your Orchard account."
	>
		<div class="org-sso-actions">
			{#each providers as provider (provider.id)}
				<Button variant="primary" href={`${provider.startUrl}?returnTo=${returnTo}`}>
					{provider.label}
				</Button>
			{/each}
			<LeaveOrganizationButton {organization} />
		</div>
	</EmptyState>
</div>

<style>
	.org-sso-required {
		min-height: 100dvh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
	}

	.org-sso-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.5rem;
	}
</style>
