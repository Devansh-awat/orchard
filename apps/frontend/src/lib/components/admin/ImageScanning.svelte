<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { SectionCard, Badge } from '$lib/components/ui';
	import RadioGroup from '$lib/components/ui/RadioGroup.svelte';

	type Scanner = 'off' | 'harbor' | 'trivy';

	interface State {
		value: Scanner;
		dbValue: Scanner;
		envOverride: Scanner | null;
		options: { value: Scanner; available: boolean; reason: string | null }[];
	}

	const COPY: Record<Scanner, { label: string; description: string }> = {
		off: { label: 'Off', description: 'No image is scanned. Configuration checks still run.' },
		harbor: {
			label: 'Harbor',
			description: "Read results from Harbor's own scanner. Covers images Orchard builds."
		},
		trivy: {
			label: 'Orchard scanner',
			description: 'Scan with the bundled Trivy server. Covers built and external images.'
		}
	};

	let state = $state<State | null>(null);
	let saving = $state(false);
	let picked = $state<string>('off');

	const options = $derived(
		(state?.options ?? []).map((o) => ({
			value: o.value,
			label: COPY[o.value].label,
			description: o.available
				? COPY[o.value].description
				: (o.reason ?? COPY[o.value].description),
			disabled: !o.available || saving
		}))
	);

	async function load() {
		try {
			const res = await apiFetch('/apiv1/admin/instance-settings/image-scanning');
			if (!res.ok) return;
			state = await res.json();
			picked = state?.dbValue ?? 'off';
		} catch {
			state = null;
		}
	}

	async function choose(next: string) {
		if (!state || state.envOverride !== null || next === state.dbValue) return;
		saving = true;
		try {
			const res = await apiFetch('/apiv1/admin/instance-settings/image-scanning', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: next })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body?.message || 'Could not save');
			state = body;
			picked = body.dbValue;
			toasts.add({
				title:
					next === 'off' ? 'Image scanning off' : `Scanning with ${COPY[next as Scanner].label}`,
				color: 'success'
			});
		} catch (e) {
			picked = state.dbValue;
			toasts.add({ title: e instanceof Error ? e.message : 'Request failed', color: 'error' });
		} finally {
			saving = false;
		}
	}

	onMount(load);
</script>

{#if state}
	<SectionCard
		title="Image scanning"
		description="Checks each app's image for known vulnerabilities and shows them on its Security tab."
	>
		{#if state.envOverride !== null}
			<div class="scan-locked">
				<Badge tone="neutral">env override</Badge>
				<span>
					Pinned to <span class="font-mono">{state.envOverride}</span> by the
					<span class="font-mono">IMAGE_SCANNER</span> env var. Unset it to choose here.
				</span>
			</div>
		{:else}
			<RadioGroup
				label="Scanner"
				variant="cards"
				columns={3}
				{options}
				bind:value={picked}
				onchange={choose}
			/>
		{/if}
	</SectionCard>
{/if}

<style>
	.scan-locked {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: var(--text-caption);
		color: var(--text-muted);
	}
</style>
