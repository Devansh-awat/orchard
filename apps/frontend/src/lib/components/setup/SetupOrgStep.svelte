<script lang="ts">
	import { onMount } from 'svelte';
	import { animate } from 'motion';
	import { apiFetch, organizations, toasts } from '$lib/stores';
	import { transition } from '$lib/utils/motion.svelte';

	let {
		onDone,
		onSkip
	}: { onDone: () => Promise<void> | void; onSkip: () => Promise<void> | void } = $props();

	type Org = { id: string; name: string; slug: string };

	let org = $state<Org | null>(null);
	let name = $state('');
	let saving = $state(false);
	let slugEl = $state<HTMLElement | null>(null);

	const slug = $derived(
		(name || '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+/, '')
			.replace(/-+$/, '')
			.slice(0, 60) ||
			(org?.slug ?? 'your-org')
	);
	const dirty = $derived(!!org && name.trim().length > 0 && name.trim() !== org.name);
	const host = $derived(typeof window === 'undefined' ? '' : window.location.host);

	$effect(() => {
		void slug;
		if (slugEl) animate(slugEl, { scale: [0.9, 1] }, transition('bouncy'));
	});

	onMount(async () => {
		const response = await apiFetch('/apiv1/organizations/user');
		if (!response.ok) return;
		const list = await response.json();
		org = Array.isArray(list) ? (list[0] ?? null) : null;
		name = org?.name ?? '';
	});

	async function save() {
		if (!org || saving) return;
		saving = true;
		try {
			const response = await apiFetch(`/apiv1/admin/organizations/${org.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: name.trim() })
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body?.message || 'Could not rename the organization');
			}
			const refreshed = await apiFetch('/apiv1/organizations/user');
			if (refreshed.ok) organizations.set(await refreshed.json());
			await onDone();
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : 'Could not rename the organization',
				color: 'error'
			});
		} finally {
			saving = false;
		}
	}
</script>

<section class="setup-step">
	<h2>Name your organization</h2>
	<p>We made one already. Rename it, or keep what is there.</p>

	<div class="setup-body">
		<input bind:value={name} placeholder={org?.name ?? ''} aria-label="Organization name" />
		<p class="setup-slug">
			<span class="scheme">https://</span>{host}/<b bind:this={slugEl}>{slug}</b>
		</p>
	</div>

	<div class="setup-acts">
		<button class="setup-pill" disabled={!dirty || saving} onclick={save}>
			{saving ? 'Saving' : 'Save'}
		</button>
		<button class="setup-ghost" onclick={onSkip}>Keep it</button>
	</div>
</section>

<style>
	.setup-slug {
		max-width: none;
		margin-top: 0.65rem;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--setup-ink-soft);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.setup-slug .scheme {
		color: var(--setup-ink-faint);
	}

	.setup-slug b {
		display: inline-block;
		color: var(--setup-crimson);
		font-weight: 400;
	}
</style>
