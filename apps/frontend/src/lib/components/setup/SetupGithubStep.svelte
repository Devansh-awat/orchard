<script lang="ts">
	import { Button, Field, Input, Spinner } from '$lib/components/ui';
	import { Pending } from './pending.svelte';
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { createGithubApp } from '$lib/queries/github';

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

	const uid = $props.id();
	const continuing = new Pending();

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
			await createGithubApp(organization, '/setup');
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
		<div class="setup-body setup-spinner"><Spinner size={20} /></div>
	{:else if status?.configured}
		<h2>GitHub is connected</h2>
		<p>
			Created as <b class="gh-slug">{status.slug ?? 'your App'}</b>. Install it on the accounts
			whose repositories you want to deploy.
		</p>

		<div class="setup-acts">
			{#if status.installUrl}
				<Button
					variant="primary"
					size="lg"
					shape="capsule"
					href={status.installUrl}
					target="_blank"
					rel="noreferrer"
				>
					Install the App
				</Button>
			{/if}
			<Button
				variant="ghost"
				size="lg"
				shape="capsule"
				loading={continuing.active}
				onclick={() => continuing.run(onDone)}
			>
				Continue
			</Button>
		</div>
	{:else if locked}
		<h2>Connect GitHub</h2>
		<p>Environment variables set the GitHub App on this instance, so you have nothing to create.</p>
		<div class="setup-acts">
			<Button
				variant="primary"
				size="lg"
				shape="capsule"
				loading={continuing.active}
				onclick={() => continuing.run(onDone)}
			>
				Continue
			</Button>
		</div>
	{:else}
		<h2>Connect GitHub</h2>
		<p>
			Create a GitHub App in one click. Without it, private repositories and rebuilds on push don't
			work. Public repositories still deploy.
		</p>

		<div class="setup-body setup-fields">
			<Field
				label="GitHub organization"
				for="{uid}-org"
				hint="Leave it blank to create the App on your personal account."
			>
				<Input
					id="{uid}-org"
					size="lg"
					bind:value={organization}
					autocomplete="off"
					spellcheck="false"
				/>
			</Field>
		</div>

		<div class="setup-acts">
			<Button
				variant="primary"
				size="lg"
				shape="capsule"
				loading={creating}
				disabled={continuing.active}
				onclick={create}
			>
				Create GitHub App
			</Button>
			<Button
				variant="ghost"
				size="lg"
				shape="capsule"
				loading={continuing.active}
				disabled={creating}
				onclick={() => continuing.run(onSkip)}
			>
				Skip for now
			</Button>
		</div>
	{/if}
</section>

<style>
	.gh-slug {
		color: var(--setup-crimson);
		font-weight: 500;
	}
</style>
