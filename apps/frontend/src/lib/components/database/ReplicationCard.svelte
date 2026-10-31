<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { SectionCard, Skeleton } from '$lib/components/ui';
	import RadioGroup from '$lib/components/ui/RadioGroup.svelte';
	import { errorMessage } from './recovery';
	import type { DatabaseDetail } from './types';

	type Mode = 'async' | 'preferred' | 'required';

	let {
		database,
		resourcesHref
	}: {
		database: DatabaseDetail;
		resourcesHref: string;
	} = $props();

	let mode = $state<Mode | null>(null);
	let instances = $state(1);
	let saving = $state(false);

	const single = $derived(instances < 2);

	const options = $derived([
		{
			value: 'async',
			label: 'Async',
			description: 'A failover can lose the last moments of writes.'
		},
		{
			value: 'preferred',
			label: 'Preferred',
			description: single
				? 'Needs a second instance.'
				: 'Each commit waits for a standby while one is healthy.',
			disabled: single
		},
		{
			value: 'required',
			label: 'Required',
			description: single
				? 'Needs a second instance.'
				: 'No acknowledged write is ever lost, but writes stop if no standby is reachable.',
			disabled: single
		}
	]);

	async function load() {
		try {
			const res = await apiFetch(`/apiv1/databases/${database.id}/replication`);
			if (!res.ok) return;
			const data = await res.json();
			mode = data.mode;
			instances = data.instances ?? database.replicas ?? 1;
		} catch {
			return;
		}
	}

	async function pick(next: string) {
		const previous = mode;
		if (next === previous) return;
		mode = next as Mode;
		saving = true;
		try {
			const res = await apiFetch(`/apiv1/databases/${database.id}/replication`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mode: next })
			});
			if (!res.ok) throw new Error(await errorMessage(res, 'Could not save'));
			const data = await res.json();
			mode = data.mode;
			instances = data.instances ?? instances;
			toasts.add({ title: 'High availability saved', color: 'success' });
		} catch (e) {
			mode = previous;
			toasts.add({
				title: 'Could not change high availability',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}

	onMount(load);
</script>

<SectionCard title="High availability">
	{#if mode === null}
		<div class="placeholder">
			<Skeleton height="2.75rem" />
			<Skeleton height="2.75rem" />
			<Skeleton height="2.75rem" />
		</div>
	{:else}
		<div class="body">
			<RadioGroup
				label="When a write counts as saved"
				{options}
				value={mode}
				disabled={saving}
				onchange={pick}
			/>
			{#if single}
				<p class="note">
					This database runs one instance. <a href={resourcesHref}>Add a standby</a> to wait for it.
				</p>
			{/if}
		</div>
	{/if}
</SectionCard>

<style>
	.body,
	.placeholder {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.note {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.note a {
		color: var(--text-link);
	}
</style>
