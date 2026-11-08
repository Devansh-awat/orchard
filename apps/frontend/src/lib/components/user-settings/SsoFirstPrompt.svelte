<script lang="ts">
	import { Alert, Button } from '$lib/components/ui';
	import { apiFetch, organizations, user } from '$lib/stores';

	let { returnTo, purpose }: { returnTo: string; purpose: string } = $props();

	let starts = $state<Array<{ id: string; name: string; startUrl: string }>>([]);

	const blocked = $derived(
		$organizations.filter(
			(o) => o.ssoRequired && !($user?.ssoGrants ?? []).some((g) => g.organizationId === o.id)
		)
	);

	$effect(() => {
		const orgs = blocked;
		if (!orgs.length) {
			starts = [];
			return;
		}
		void Promise.all(
			orgs.map(async (org) => {
				const res = await apiFetch(`/apiv1/sso/org/${encodeURIComponent(org.slug)}`).catch(
					() => null
				);
				const context = res?.ok ? await res.json() : null;
				const provider = context?.providers?.[0];
				return provider ? { id: org.id, name: org.name, startUrl: provider.startUrl } : null;
			})
		).then((list) => {
			starts = list.filter((s): s is { id: string; name: string; startUrl: string } => !!s);
		});
	});
</script>

{#each starts as start (start.id)}
	<Alert tone="info" title="{start.name} requires single sign-on">
		To {purpose} with {start.name}, sign in with its single sign-on first.
		{#snippet actions()}
			<Button
				size="sm"
				variant="ghost"
				href={`${start.startUrl}?returnTo=${encodeURIComponent(returnTo)}`}>Continue</Button
			>
		{/snippet}
	</Alert>
{/each}
