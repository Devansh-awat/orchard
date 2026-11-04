<script lang="ts">
	import { Button, RadioGroup } from '$lib/components/ui';
	import { apiFetch, instanceFeatures, toasts } from '$lib/stores';

	let { onDone }: { onDone: () => Promise<void> | void } = $props();

	type Mode = 'off' | 'on';

	const OPTIONS: { value: Mode; label: string; description: string }[] = [
		{
			value: 'off',
			label: 'Off',
			description:
				"Apps can use all of this server's resources, and one app can use up the whole server."
		},
		{
			value: 'on',
			label: 'On',
			description: 'Apps get the default limits, which you can change per organization.'
		}
	];

	let picked = $state<Mode>('off');
	let saving = $state(false);

	async function save() {
		if (saving) return;
		saving = true;
		try {
			const response = await apiFetch('/apiv1/admin/instance-settings/resource-limits', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: picked })
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body?.message || "Couldn't save your choice");
			}
			await instanceFeatures.load(true);
			await onDone();
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : "Couldn't save your choice",
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}
</script>

<section class="setup-step">
	<h2>Resource limits</h2>
	<p>You can change this later in Instance admin.</p>

	<div class="setup-body setup-fields">
		<RadioGroup
			label="Resource limits"
			variant="cards"
			columns={1}
			options={OPTIONS}
			bind:value={picked}
			disabled={saving}
		/>
	</div>

	<div class="setup-acts">
		<Button variant="primary" size="lg" shape="capsule" loading={saving} onclick={save}>
			Continue
		</Button>
	</div>
</section>
