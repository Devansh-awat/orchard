<script lang="ts">
	import { Button } from '$lib/components/ui';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { apiFetch, toasts } from '$lib/stores';

	let { organization }: { organization: { id: string; name: string } } = $props();

	let confirming = $state(false);

	async function leave() {
		const response = await apiFetch(`/apiv1/organizations/${organization.id}/leave`, {
			method: 'POST'
		});
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			toasts.add({
				title: "Couldn't leave the organization",
				description: body?.message ?? 'Try again in a moment.',
				color: 'error'
			});
			return;
		}
		window.location.assign('/');
	}
</script>

<Button variant="secondary" onclick={() => (confirming = true)}>Leave organization</Button>

<ConfirmModal
	bind:open={confirming}
	title={`Leave ${organization.name}?`}
	description="You lose access to its projects. Your account and your other organizations stay as they are."
	confirmLabel="Leave organization"
	onconfirm={leave}
	oncancel={() => {}}
/>
