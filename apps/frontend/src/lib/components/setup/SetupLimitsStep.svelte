<script lang="ts">
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

	<div class="setup-body limits" role="radiogroup" aria-label="Resource limits">
		{#each OPTIONS as option (option.value)}
			<label class="limit" class:picked={picked === option.value}>
				<input type="radio" name="limits" value={option.value} bind:group={picked} />
				<span class="limit-label">{option.label}</span>
				<span class="limit-note">{option.description}</span>
			</label>
		{/each}
	</div>

	<div class="setup-acts">
		<button class="setup-pill" disabled={saving} onclick={save}>
			{saving ? 'Saving' : 'Continue'}
		</button>
	</div>
</section>

<style>
	.limits {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		text-align: left;
	}

	.limit {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding: 0.75rem 0.85rem;
		border-radius: 0.75rem;
		border: 1px solid var(--setup-line);
		background: rgba(255, 255, 255, 0.55);
		cursor: pointer;
		transition: border-color 0.2s ease;
	}

	.limit.picked {
		border-color: var(--setup-crimson);
	}

	.limit:focus-within {
		outline: 2px solid var(--setup-crimson);
		outline-offset: 2px;
	}

	.setup-step .limit input {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		opacity: 0;
	}

	.limit-label {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--setup-ink);
	}

	.limit-note {
		font-size: 0.78125rem;
		line-height: 1.45;
		color: var(--setup-ink-soft);
	}
</style>
