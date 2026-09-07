<script lang="ts">
	import { onMount } from 'svelte';
	import { Building2, Sparkles } from 'lucide-svelte';
	import { Button, Field, Input, SectionCard, Skeleton } from '$lib/components/ui';
	import { apiFetch, organizations, toasts } from '$lib/stores';
	import { motionStagger, springPop } from '$lib/utils/motion.svelte';

	let {
		onDone,
		onSkip
	}: { onDone: () => Promise<void> | void; onSkip: () => Promise<void> | void } = $props();

	type Org = { id: string; name: string; slug: string };

	let org = $state<Org | null>(null);
	let loading = $state(true);
	let name = $state('');
	let saving = $state(false);

	const slug = $derived(
		(name || '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+/, '')
			.replace(/-+$/, '')
			.slice(0, 60)
	);
	const dirty = $derived(!!org && name.trim().length > 0 && name.trim() !== org.name);

	onMount(async () => {
		try {
			const response = await apiFetch('/apiv1/organizations/user');
			if (response.ok) {
				const list = await response.json();
				org = Array.isArray(list) ? (list[0] ?? null) : null;
				name = org?.name ?? '';
			}
		} finally {
			loading = false;
		}
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
			toasts.add({ title: 'Organization renamed', color: 'success' });
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

<div class="step" {@attach motionStagger({ index: 0 })}>
	<SectionCard
		title="We made you an organization"
		description="Everything you deploy lives inside one. You have a working org already, so this is only about naming it."
	>
		{#if loading}
			<Skeleton class="h-24 w-full" />
		{:else if !org}
			<p class="muted">No organization found. You can create one from the admin area later.</p>
			<div class="actions">
				<Button onclick={onSkip}>Continue</Button>
			</div>
		{:else}
			<div class="org-card" {@attach springPop(() => !loading)}>
				<div class="org-avatar"><Building2 size={18} /></div>
				<div class="org-body">
					<p class="org-name">{name.trim() || org.name}</p>
					<p class="org-url">
						<span class="org-url-host">this instance</span><span class="org-url-slash">/</span
						><span class="org-url-slug">{slug || org.slug}</span>
					</p>
				</div>
				<Sparkles size={15} class="org-spark" />
			</div>

			<Field label="Name it something you recognise" for="org-name">
				<Input id="org-name" bind:value={name} placeholder={org.name} autocomplete="organization" />
			</Field>

			<div class="actions">
				<Button onclick={onSkip}>Keep {org.name}</Button>
				<Button variant="primary" loading={saving} disabled={!dirty} onclick={save}>Save</Button>
			</div>
		{/if}
	</SectionCard>
</div>

<style>
	.step {
		display: flex;
		flex-direction: column;
	}

	.muted {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.875rem;
	}

	.org-card {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.875rem 1rem;
		margin-bottom: 1.25rem;
		border: 1px solid var(--border-default);
		border-radius: 0.75rem;
		background: var(--bg-raised);
	}

	.org-avatar {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.625rem;
		background: var(--accent-subtle);
		color: var(--accent);
		flex-shrink: 0;
	}

	.org-body {
		min-width: 0;
		flex: 1;
	}

	.org-name {
		margin: 0;
		font-weight: 600;
		color: var(--text-fg);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.org-url {
		margin: 0.125rem 0 0;
		font-size: 0.75rem;
		font-family: ui-monospace, monospace;
		color: var(--text-faint);
	}

	.org-url-slash {
		opacity: 0.5;
	}

	.org-url-slug {
		color: var(--accent);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1.25rem;
	}
</style>
