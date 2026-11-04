<script lang="ts">
	import { goto } from '$app/navigation';
	import { Building2 } from 'lucide-svelte';
	import {
		Alert,
		Button,
		Dropdown,
		Field,
		FieldGrid,
		Input,
		Modal,
		RemoteImg,
		Spinner,
		Stack
	} from '$lib/components/ui';
	import { apiFetch, toasts, organizations } from '$lib/stores';

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

	const uid = $props.id();

	let selectedOrgId = $state('');
	let slug = $state('');
	let preview = $state<Preview | null>(null);
	let loadingPreview = $state(false);
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let wasOpen = false;

	const eligibleOrgs = $derived(
		$organizations.filter((o) => o.id !== currentOrgId && o.myRole && o.myRole !== 'guest')
	);
	const orgOptions = $derived(eligibleOrgs.map((o) => ({ value: o.id, label: o.name })));
	const selectedOrg = $derived(eligibleOrgs.find((o) => o.id === selectedOrgId) ?? null);
	const destName = $derived(selectedOrg?.name ?? 'the new organization');

	$effect(() => {
		if (open && !wasOpen) {
			wasOpen = true;
			selectedOrgId = '';
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
				throw new Error(d.message || "Couldn't preview the move");
			}
			preview = await res.json();
		} catch (e) {
			if (token === previewToken) {
				error = e instanceof Error ? e.message : "Couldn't preview the move";
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

	function onOrgPicked() {
		clearTimeout(slugDebounce);
		preview = null;
		fetchPreview();
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
				throw new Error(d.message || "Couldn't move the project");
			}
			const result = await res.json();
			toasts.add({
				title: 'Project moved',
				description: `${projectName} moved to ${destName}`,
				color: 'success'
			});
			open = false;
			onmoved?.(result);
			goto(`/${result.destinationOrgSlug}/projects/${result.slug}`);
		} catch (e) {
			error = e instanceof Error ? e.message : "Couldn't move the project";
		} finally {
			submitting = false;
		}
	}

	function plural(n: number, word: string) {
		return `${n} ${word}${n === 1 ? '' : 's'}`;
	}
</script>

<Modal bind:open title="Move {projectName}">
	{#if eligibleOrgs.length === 0}
		<p class="text-body text-muted">
			You aren't in another organization where you can create projects. Ask one of its owners to add
			you.
		</p>
	{:else}
		<Stack>
			<FieldGrid>
				<Field label="Organization" for="{uid}-org">
					<Dropdown
						id="{uid}-org"
						size="lg"
						placeholder="Choose one"
						bind:value={selectedOrgId}
						options={orgOptions}
						onchange={onOrgPicked}
					>
						{#snippet icon(id)}
							{@const org = eligibleOrgs.find((o) => o.id === id)}
							{#if org?.avatarUrl}
								<span class="org-avatar"
									><RemoteImg src={org.avatarUrl} class="org-avatar-img" /></span
								>
							{:else}
								<Building2 size={16} />
							{/if}
						{/snippet}
					</Dropdown>
				</Field>
				<Field
					label="Slug"
					for="{uid}-slug"
					error={preview?.slugCollision ? `Already taken in ${destName}` : null}
				>
					<Input
						id="{uid}-slug"
						size="lg"
						mono
						bind:value={slug}
						oninput={onSlugInput}
						placeholder={currentSlug}
						error={!!preview?.slugCollision}
						autocomplete="off"
						spellcheck="false"
					/>
				</Field>
			</FieldGrid>

			{#if loadingPreview && !preview}
				<p class="flex items-center gap-2 text-callout text-muted">
					<Spinner size={14} />
					Checking what changes
				</p>
			{:else if preview}
				<Stack gap="xs">
					{#if preview.membersLosingAccess.length > 0}
						<Alert
							tone="warning"
							title="{plural(preview.membersLosingAccess.length, 'member')} lose access"
						>
							{preview.membersLosingAccess.map((m) => m.username).join(', ')}
							{preview.membersLosingAccess.length === 1 ? 'is' : 'are'} not in {destName}.
							{plural(preview.membersKept, 'member')} keep access.
						</Alert>
					{/if}

					{#if preview.ownerReassignedToMover}
						<Alert tone="info" title="You become the owner">
							The current owner isn't in {destName}, so everything here counts against your
							allowance.
						</Alert>
					{/if}

					{#if preview.quota?.willExceed}
						<Alert tone="warning" title="Over {destName}'s quota">
							The project moves, but new deploys may be blocked until there is room.
						</Alert>
					{/if}

					{#if pausing}
						<Alert tone="error" title="New database backups stop">
							{destName} has no backup storage. Databases keep running but take no new backups until you
							set up backup storage there. Existing backups stay restorable.
						</Alert>
					{:else if preview.backups.willContinue}
						<Alert tone="info" title="Backups keep running">
							{plural(preview.backups.databaseCount, 'database')} start archiving to {destName}'s
							storage. Existing backups stay restorable.
						</Alert>
					{/if}
				</Stack>
			{/if}

			{#if error}
				<Alert tone="error">{error}</Alert>
			{/if}
		</Stack>
	{/if}

	{#snippet footer()}
		<Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
		{#if eligibleOrgs.length > 0}
			<Button
				variant={pausing ? 'danger' : 'primary'}
				loading={submitting}
				disabled={!canSubmit}
				onclick={submit}
			>
				{pausing ? 'Move anyway' : 'Move project'}
			</Button>
		{/if}
	{/snippet}
</Modal>

<style>
	.org-avatar {
		display: block;
		width: 1rem;
		height: 1rem;
		overflow: hidden;
		border-radius: calc(0.25rem * var(--corner-scale));
		corner-shape: var(--corner);
	}
	.org-avatar :global(.org-avatar-img) {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
</style>
