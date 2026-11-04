<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';

	let {
		onDone,
		onSkip
	}: { onDone: () => Promise<void> | void; onSkip: () => Promise<void> | void } = $props();

	type Status = {
		configured: boolean;
		slug: string | null;
		lockedFields: string[];
		installUrl: string | null;
	};

	let status = $state<Status | null>(null);
	let organization = $state('');
	let creating = $state(false);
	let loading = $state(true);

	const locked = $derived((status?.lockedFields.length ?? 0) > 0);

	onMount(async () => {
		try {
			const response = await apiFetch('/apiv1/setup/github-app/status');
			if (response.ok) status = await response.json();
		} catch {
			status = null;
		} finally {
			loading = false;
		}
	});

	async function create() {
		creating = true;
		try {
			const response = await apiFetch('/apiv1/setup/github-app/manifest', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					organization: organization.trim() || undefined,
					// Creating the App leaves this page for github.com entirely, so
					// the round trip has to carry its own way back into the flow.
					returnTo: '/setup'
				})
			});
			if (!response.ok) throw new Error("Couldn't create the GitHub App");

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
			toasts.add({
				title: e instanceof Error ? e.message : "Couldn't create the GitHub App",
				color: 'error'
			});
			creating = false;
		}
	}
</script>

<section class="setup-step">
	{#if loading}
		<h2>Connect GitHub</h2>
		<div class="setup-body setup-pulse"><i></i><i></i><i></i></div>
	{:else if status?.configured}
		<h2>GitHub is connected</h2>
		<p>
			Created as <b class="gh-slug">{status.slug ?? 'your App'}</b>. Install it on the accounts
			whose repositories you want to deploy.
		</p>

		<div class="setup-acts">
			{#if status.installUrl}
				<a class="setup-pill" href={status.installUrl} target="_blank" rel="noreferrer">
					Install the App
				</a>
			{/if}
			<button class="setup-ghost" onclick={onDone}>Continue</button>
		</div>
	{:else if locked}
		<h2>Connect GitHub</h2>
		<p>Environment variables set the GitHub App on this instance, so you have nothing to create.</p>
		<div class="setup-acts">
			<button class="setup-pill" onclick={onDone}>Continue</button>
		</div>
	{:else}
		<h2>Connect GitHub</h2>
		<p>
			Create a GitHub App in one click. Without it, private repositories and rebuilds on push don't
			work. Public repositories still deploy.
		</p>

		<div class="setup-body">
			<input
				bind:value={organization}
				placeholder="GitHub organization (optional)"
				aria-label="GitHub organization"
				autocomplete="off"
				spellcheck="false"
			/>
			<p class="setup-note">Leave it blank to create the App on your personal account.</p>
		</div>

		<div class="setup-acts">
			<button class="setup-pill" disabled={creating} onclick={create}>
				{creating ? 'Opening GitHub' : 'Create GitHub App'}
			</button>
			<button class="setup-ghost" onclick={onSkip}>Skip for now</button>
		</div>
	{/if}
</section>

<style>
	.gh-slug {
		color: var(--setup-crimson);
		font-weight: 500;
	}

	a.setup-pill {
		display: block;
		text-align: center;
		text-decoration: none;
	}
</style>
