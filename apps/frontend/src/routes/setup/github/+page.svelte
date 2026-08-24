<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { Github, Loader2, ExternalLink, Lock } from 'lucide-svelte';
	import { isSignedIn, isSuperAdmin, apiFetch, toasts } from '$lib/stores';
	import { Alert, Button, Field, Input, SectionCard } from '$lib/components/ui';
	import { motionStagger } from '$lib/utils/motion.svelte';

	interface Status {
		configured: boolean;
		slug: string | null;
		appId: string | null;
		lockedFields: string[];
		installUrl: string | null;
	}

	let loading = $state(true);
	let status = $state<Status | null>(null);
	let organization = $state('');
	let creating = $state(false);
	let error = $state<string | null>(null);

	const locked = $derived((status?.lockedFields.length ?? 0) > 0);

	onMount(async () => {
		if (!$isSignedIn) {
			goto('/', { replaceState: true });
			return;
		}

		error = $page.url.searchParams.get('error');
		if ($page.url.searchParams.get('created')) {
			toasts.add({ title: 'GitHub App created', color: 'success' });
		}

		await refresh();
	});

	async function refresh() {
		loading = true;
		try {
			const response = await apiFetch('/apiv1/setup/github-app/status');
			status = response.ok ? await response.json() : null;
		} catch {
			status = null;
		} finally {
			loading = false;
		}
	}

	async function createApp() {
		creating = true;
		error = null;
		try {
			const response = await apiFetch('/apiv1/setup/github-app/manifest', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ organization: organization.trim() || undefined })
			});
			if (!response.ok) throw new Error('Could not start the App creation');

			const { postUrl, manifest, state } = await response.json();

			const form = document.createElement('form');
			form.method = 'POST';
			form.action = `${postUrl}?state=${encodeURIComponent(state)}`;

			const field = document.createElement('input');
			field.type = 'hidden';
			field.name = 'manifest';
			field.value = manifest;

			form.appendChild(field);
			document.body.appendChild(form);
			form.submit();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not start the App creation';
			creating = false;
		}
	}

	async function disconnect() {
		try {
			const response = await apiFetch('/apiv1/setup/github-app', { method: 'DELETE' });
			if (!response.ok) throw new Error('Could not disconnect');
			toasts.add({ title: 'GitHub App disconnected', color: 'success' });
			await refresh();
		} catch (e) {
			toasts.add({
				title: e instanceof Error ? e.message : 'Could not disconnect',
				color: 'error'
			});
		}
	}
</script>

<svelte:head><title>Connect GitHub</title></svelte:head>

<div class="github-setup">
	{#if loading}
		<div class="github-loading" data-motion="progress">
			<Loader2 size={20} class="animate-spin" />
		</div>
	{:else if !$isSuperAdmin}
		<SectionCard title="Connect GitHub">
			<Alert tone="info" title="Superadmin only">
				Ask a superadmin to connect this instance to GitHub.
			</Alert>
		</SectionCard>
	{:else}
		<div {@attach motionStagger({ index: 0 })}>
			<SectionCard
				title="Connect GitHub"
				description="Orchard deploys from GitHub through its own App. Creating one takes a single click."
			>
				{#if error}
					<Alert tone="error" title="That did not work">{error}</Alert>
				{/if}

				{#if status?.configured}
					<Alert tone="success" title={status.slug ? `Connected as ${status.slug}` : 'Connected'}>
						App ID {status.appId}. Install it on the accounts whose repositories you want to deploy.
					</Alert>

					{#if locked}
						<div class="github-locked">
							<Lock size={13} />
							<span>Pinned by environment variables, so it cannot be changed here.</span>
						</div>
					{/if}

					<div class="github-actions">
						{#if !locked}
							<Button variant="danger" onclick={disconnect}>Disconnect</Button>
						{/if}
						{#if status.installUrl}
							<Button variant="primary" href={status.installUrl} target="_blank" rel="noreferrer">
								<Github size={15} />
								Install the App
								<ExternalLink size={13} />
							</Button>
						{/if}
					</div>
				{:else}
					<div class="github-form">
						<Field
							label="GitHub organization"
							hint="Leave blank to create the App on your personal account."
							for="github-org"
						>
							<Input
								id="github-org"
								bind:value={organization}
								placeholder="my-org"
								autocomplete="off"
								spellcheck="false"
							/>
						</Field>
						<div class="github-actions">
							<Button variant="primary" loading={creating} onclick={createApp}>
								<Github size={15} />
								Create GitHub App
							</Button>
						</div>
					</div>
				{/if}
			</SectionCard>
		</div>
	{/if}
</div>

<style>
	.github-setup {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100dvh;
		padding: 2rem 1rem;
	}

	.github-setup > div,
	.github-setup > :global(section) {
		width: 100%;
		max-width: 32rem;
	}

	.github-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
	}

	.github-form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.github-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	.github-locked {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-top: 0.75rem;
		font-size: 0.8125rem;
		color: var(--text-faint);
	}
</style>
