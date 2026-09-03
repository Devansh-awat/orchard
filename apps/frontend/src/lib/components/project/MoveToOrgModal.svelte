<script lang="ts">
	import { goto } from '$app/navigation';
	import { Check, Loader2, ArrowLeft } from 'lucide-svelte';
	import { Modal, Button, Alert, Field, Input } from '$lib/components/ui';
	import { apiFetch, toasts, organizations } from '$lib/stores';
	import { motionStagger } from '$lib/utils/motion.svelte';

	type PreviewMember = { id: string; username: string };
	type Preview = {
		destinationOrg: { id: string; name: string; slug: string };
		proposedSlug: string;
		slugCollision: boolean;
		membersLosingAccess: PreviewMember[];
		membersKept: number;
		ownerReassignedToMover: boolean;
		quota: { willExceed: boolean } | null;
		backups: { databaseCount: number; willContinue: boolean; willPause: boolean };
	};

	let {
		open = $bindable(false),
		projectId,
		projectName,
		currentSlug,
		currentOrgId,
		onmoved
	}: {
		open?: boolean;
		projectId: string;
		projectName: string;
		currentSlug: string;
		currentOrgId: string;
		onmoved?: (result: { slug: string; destinationOrgSlug: string }) => void;
	} = $props();

	let step = $state<'destination' | 'review'>('destination');
	let selectedOrgId = $state<string | null>(null);
	let slug = $state('');
	let preview = $state<Preview | null>(null);
	let loadingPreview = $state(false);
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let wasOpen = false;

	const eligibleOrgs = $derived(
		$organizations.filter((o) => o.id !== currentOrgId && o.myRole && o.myRole !== 'guest')
	);
	const selectedOrg = $derived(eligibleOrgs.find((o) => o.id === selectedOrgId) ?? null);

	$effect(() => {
		if (open && !wasOpen) {
			wasOpen = true;
			step = 'destination';
			selectedOrgId = null;
			slug = currentSlug;
			preview = null;
			error = null;
		} else if (!open) {
			wasOpen = false;
		}
	});

	let previewToken = 0;
	async function fetchPreview() {
		if (!selectedOrgId) return;
		const token = ++previewToken;
		loadingPreview = true;
		error = null;
		try {
			const params = new URLSearchParams({ destinationOrgId: selectedOrgId });
			if (slug.trim()) params.set('slug', slug.trim());
			const res = await apiFetch(`/apiv1/projects/${projectId}/transfer-org/preview?${params}`);
			if (token !== previewToken) return;
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Could not preview the move');
			}
			preview = await res.json();
		} catch (e) {
			if (token === previewToken) {
				error = e instanceof Error ? e.message : 'Could not preview the move';
				preview = null;
			}
		} finally {
			if (token === previewToken) loadingPreview = false;
		}
	}

	let slugDebounce: ReturnType<typeof setTimeout>;
	function onSlugInput() {
		clearTimeout(slugDebounce);
		slugDebounce = setTimeout(fetchPreview, 400);
	}

	async function goToReview() {
		if (!selectedOrgId) return;
		step = 'review';
		await fetchPreview();
	}

	const pausing = $derived(Boolean(preview?.backups.willPause));
	const canSubmit = $derived(
		Boolean(selectedOrgId) && !loadingPreview && !submitting && !!preview && !preview.slugCollision
	);

	async function submit() {
		if (!canSubmit || !selectedOrgId) return;
		submitting = true;
		error = null;
		try {
			const res = await apiFetch(`/apiv1/projects/${projectId}/transfer-org`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ destinationOrgId: selectedOrgId, slug: slug.trim() || undefined })
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.message || 'Could not move the project');
			}
			const result = await res.json();
			toasts.add({
				title: 'Project moved',
				description: `${projectName} now lives in ${selectedOrg?.name ?? 'the new organization'}`,
				color: 'success'
			});
			open = false;
			onmoved?.(result);
			goto(`/${result.destinationOrgSlug}/projects/${result.slug}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not move the project';
		} finally {
			submitting = false;
		}
	}

	function monogram(name: string) {
		return name.trim().charAt(0).toUpperCase() || '?';
	}
</script>

<Modal bind:open size="sm" title="Move to organization">
	{#if step === 'destination'}
		<p class="mv-lead">
			Move <strong>{projectName}</strong> to another organization you belong to. Everything running
			in it comes along.
		</p>

		{#if eligibleOrgs.length > 0}
			<ul class="mv-list">
				{#each eligibleOrgs as org, i (org.id)}
					<li {@attach motionStagger({ index: i, axis: 'x', from: { y: -8 } })}>
						<button
							type="button"
							class="mv-option"
							class:is-selected={selectedOrgId === org.id}
							aria-pressed={selectedOrgId === org.id}
							onclick={() => (selectedOrgId = org.id)}
						>
							<span class="mv-mono" aria-hidden="true">
								{#if org.avatarUrl}
									<img src={org.avatarUrl} alt="" />
								{:else}
									{monogram(org.name)}
								{/if}
							</span>
							<span class="mv-option-text">
								<span class="mv-option-name">{org.name}</span>
								<span class="mv-option-slug">{org.slug}</span>
							</span>
							<span class="mv-option-check">
								{#if selectedOrgId === org.id}<Check size={14} />{/if}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="mv-empty">
				You are not a member of any other organization where you can create projects. Ask an owner
				to add you first.
			</p>
		{/if}
	{:else}
		<p class="mv-lead">
			Moving <strong>{projectName}</strong> to <strong>{selectedOrg?.name}</strong>.
		</p>

		<Field
			label="Project name in the new organization"
			hint="This becomes the project's URL slug. Change it if the name is already taken."
			error={preview?.slugCollision ? 'That name is already taken in this organization.' : null}
		>
			<Input bind:value={slug} oninput={onSlugInput} placeholder={currentSlug} class="font-mono" />
		</Field>

		{#if loadingPreview}
			<div class="mv-loading">
				<Loader2 class="h-4 w-4 animate-spin" data-motion="progress" />
				Checking what will change
			</div>
		{:else if preview}
			<div class="mv-summary">
				{#if preview.membersLosingAccess.length > 0}
					<Alert tone="warning" title={`${preview.membersLosingAccess.length} member${preview.membersLosingAccess.length === 1 ? '' : 's'} will lose access`}>
						{preview.membersLosingAccess.map((m) => m.username).join(', ')} will be removed because they
						are not in {selectedOrg?.name}. {preview.membersKept} will keep access.
					</Alert>
				{/if}

				{#if preview.ownerReassignedToMover}
					<Alert tone="info" title="You will become the owner">
						The current owner is not in {selectedOrg?.name}, so the project's resource bill moves to
						you.
					</Alert>
				{/if}

				{#if preview.quota?.willExceed}
					<Alert tone="warning" title="Over the destination's quota">
						This project's resources exceed what's left in {selectedOrg?.name}'s quota. The move
						still works, but new deployments there may be blocked until there's room.
					</Alert>
				{/if}

				{#if pausing}
					<Alert tone="error" title="New database backups will stop">
						{selectedOrg?.name} has no backup storage set up. After the move your database keeps
						running but takes no new backups until you configure R2 there. Existing backups stay
						restorable. Set up backup storage first if you can.
					</Alert>
				{:else if preview.backups.willContinue}
					<Alert tone="info" title="Backups keep running">
						The {preview.backups.databaseCount} database{preview.backups.databaseCount === 1 ? '' : 's'}
						start archiving to {selectedOrg?.name}'s storage. Existing backups stay restorable.
					</Alert>
				{/if}
			</div>
		{/if}

		{#if error}
			<Alert tone="error">{error}</Alert>
		{/if}
	{/if}

	{#snippet footer()}
		{#if step === 'destination'}
			<Button variant="secondary" onclick={() => (open = false)}>Cancel</Button>
			<Button variant="primary" disabled={!selectedOrgId} onclick={goToReview}>Continue</Button>
		{:else}
			<Button variant="secondary" onclick={() => (step = 'destination')}>
				<ArrowLeft class="h-4 w-4" />
				Back
			</Button>
			<Button variant={pausing ? 'danger' : 'primary'} disabled={!canSubmit} onclick={submit}>
				{#if submitting}
					<Loader2 class="h-4 w-4 animate-spin" data-motion="progress" />
				{/if}
				{pausing ? 'Move anyway' : 'Move project'}
			</Button>
		{/if}
	{/snippet}
</Modal>

<style>
	.mv-lead {
		margin: 0 0 var(--space-4);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.mv-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		max-height: 17rem;
		overflow-y: auto;
	}
	.mv-option {
		width: 100%;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		background: transparent;
		cursor: pointer;
		text-align: left;
		transition:
			background-color var(--dur-fast),
			border-color var(--dur-fast);
	}
	.mv-option:hover {
		background: var(--bg-raised);
	}
	.mv-option.is-selected {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		border-color: color-mix(in srgb, var(--accent) 32%, transparent);
	}
	.mv-mono {
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius-sm);
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--bg-sunken);
		color: var(--text-muted);
		font-size: var(--text-footnote);
		font-weight: 600;
		overflow: hidden;
	}
	.mv-mono img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.mv-option-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}
	.mv-option-name {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		color: var(--text-default);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mv-option-slug {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mv-option-check {
		flex-shrink: 0;
		color: var(--accent);
	}
	.mv-empty {
		margin: 0;
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
	}
	.mv-loading {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-4);
		font-size: var(--text-footnote);
		color: var(--text-muted);
	}
	.mv-summary {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin-top: var(--space-4);
	}
</style>
