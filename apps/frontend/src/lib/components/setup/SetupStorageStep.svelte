<script lang="ts">
	import { apiFetch, instanceFeatures, toasts } from '$lib/stores';
	import { STORAGE_PROVIDERS, storageConnection, storageProvider } from '$lib/storage-providers';

	let {
		onDone,
		onSkip
	}: { onDone: () => Promise<void> | void; onSkip: () => Promise<void> | void } = $props();

	let providerId = $state('aws');
	let place = $state('');
	let endpoint = $state('');
	let region = $state('');
	let bucket = $state('');
	let accessKeyId = $state('');
	let secretAccessKey = $state('');
	let testing = $state(false);
	let saving = $state(false);
	let passed = $state(false);
	let failure = $state<string | null>(null);

	const provider = $derived(storageProvider(providerId));
	const values = $derived(
		storageConnection(providerId, place, bucket, {
			endpoint,
			region,
			accessKeyId,
			secretAccessKey
		})
	);

	$effect(() => {
		void values;
		passed = false;
		failure = null;
	});

	async function test() {
		testing = true;
		const sent = values;
		try {
			const response = await apiFetch('/apiv1/admin/instance-config/storage/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(sent)
			});
			const body = await response.json().catch(() => ({}));
			if (response.ok && body.ok) {
				passed = true;
				failure = null;
			} else {
				passed = false;
				failure = body.message || 'The connection test failed.';
			}
		} catch {
			passed = false;
			failure = 'The connection test failed.';
		} finally {
			testing = false;
		}
	}

	async function save() {
		saving = true;
		try {
			const response = await apiFetch('/apiv1/admin/instance-config/storage', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(values)
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body?.message || 'Could not save');
			}
			await instanceFeatures.load(true);
			await onDone();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : 'Could not save', color: 'error' });
		} finally {
			saving = false;
		}
	}
</script>

<section class="setup-step">
	<h2>Add S3 storage</h2>
	<p>
		Optional. Without it, backups stay on this server and are lost with it, and deploying from a
		local directory is off.
	</p>

	<div class="setup-body fields">
		<select aria-label="Provider" bind:value={providerId}>
			{#each STORAGE_PROVIDERS as option (option.id)}
				<option value={option.id}>{option.label}</option>
			{/each}
		</select>
		{#if provider.placeLabel}
			<input
				aria-label={provider.placeLabel}
				placeholder={provider.placeDefault || provider.placeLabel}
				autocomplete="off"
				spellcheck="false"
				bind:value={place}
			/>
		{:else}
			<input
				aria-label="Endpoint"
				placeholder="https://s3.example.com"
				autocomplete="off"
				spellcheck="false"
				bind:value={endpoint}
			/>
			<input
				aria-label="Region"
				placeholder="us-east-1"
				autocomplete="off"
				spellcheck="false"
				bind:value={region}
			/>
		{/if}
		<input
			aria-label="Bucket"
			placeholder="Bucket"
			autocomplete="off"
			spellcheck="false"
			bind:value={bucket}
		/>
		<input
			aria-label="Access key"
			placeholder="Access key"
			autocomplete="off"
			spellcheck="false"
			bind:value={accessKeyId}
		/>
		<input
			aria-label="Secret key"
			placeholder="Secret key"
			type="password"
			autocomplete="new-password"
			bind:value={secretAccessKey}
		/>
	</div>

	{#if failure}
		<p class="status" role="alert">{failure}</p>
	{:else if passed}
		<p class="status" role="status">Connection works.</p>
	{/if}

	<div class="setup-acts">
		{#if passed}
			<button class="setup-pill" disabled={saving} onclick={save}>
				{saving ? 'Saving' : 'Save and continue'}
			</button>
		{:else}
			<button class="setup-pill" disabled={testing} onclick={test}>
				{testing ? 'Testing' : 'Test connection'}
			</button>
		{/if}
		<button class="setup-ghost" onclick={onSkip}>Skip for now</button>
	</div>
</section>

<style>
	.fields {
		display: grid;
		gap: 0.5rem;
	}

	select {
		width: 100%;
		font: inherit;
		font-size: 0.9375rem;
		text-align: center;
		padding: 0.72rem 0.8rem;
		border-radius: 0.75rem;
		border: 1px solid var(--setup-line);
		background: rgba(255, 255, 255, 0.62);
		color: var(--setup-ink);
		outline: none;
	}

	select:focus {
		border-color: color-mix(in srgb, var(--setup-crimson) 55%, transparent);
	}
</style>
