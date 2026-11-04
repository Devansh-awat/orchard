<script lang="ts">
	import { Button, Dropdown, Field, FieldGrid, Input, SecretInput } from '$lib/components/ui';
	import { Pending } from './pending.svelte';
	import { apiFetch, instanceFeatures, toasts } from '$lib/stores';
	import { STORAGE_PROVIDERS, storageConnection, storageProvider } from '$lib/storage-providers';

	let {
		onDone,
		onSkip
	}: { onDone: () => Promise<void> | void; onSkip: () => Promise<void> | void } = $props();

	const uid = $props.id();
	const skipping = new Pending();
	const providerOptions = STORAGE_PROVIDERS.map((option) => ({
		value: option.id,
		label: option.label
	}));

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
				throw new Error(body?.message || "Couldn't save");
			}
			await instanceFeatures.load(true);
			await onDone();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : "Couldn't save", color: 'error' });
		} finally {
			saving = false;
		}
	}
</script>

<section class="setup-step">
	<h2>Add S3 storage</h2>
	<p>
		Optional. Without it, you lose your backups if you lose this server, and you can't deploy from a
		local directory.
	</p>

	<div class="setup-body setup-fields">
		<Field label="Provider" for="{uid}-provider">
			<Dropdown id="{uid}-provider" size="lg" options={providerOptions} bind:value={providerId} />
		</Field>
		{#if provider.placeLabel}
			<Field label={provider.placeLabel} for="{uid}-place">
				<Input
					id="{uid}-place"
					size="lg"
					placeholder={provider.placeDefault}
					autocomplete="off"
					spellcheck="false"
					bind:value={place}
				/>
			</Field>
		{:else}
			<Field label="Endpoint" for="{uid}-endpoint">
				<Input
					id="{uid}-endpoint"
					size="lg"
					placeholder="https://s3.example.com"
					autocomplete="off"
					spellcheck="false"
					bind:value={endpoint}
				/>
			</Field>
			<Field label="Region" for="{uid}-region">
				<Input
					id="{uid}-region"
					size="lg"
					placeholder="us-east-1"
					autocomplete="off"
					spellcheck="false"
					bind:value={region}
				/>
			</Field>
		{/if}
		<Field label="Bucket" for="{uid}-bucket">
			<Input
				id="{uid}-bucket"
				size="lg"
				autocomplete="off"
				spellcheck="false"
				bind:value={bucket}
			/>
		</Field>
		<FieldGrid>
			<Field label="Access key" for="{uid}-access">
				<Input
					id="{uid}-access"
					size="lg"
					autocomplete="off"
					spellcheck="false"
					bind:value={accessKeyId}
				/>
			</Field>
			<Field label="Secret key" for="{uid}-secret">
				<SecretInput
					id="{uid}-secret"
					size="lg"
					autocomplete="new-password"
					bind:value={secretAccessKey}
				/>
			</Field>
		</FieldGrid>
	</div>

	{#if failure}
		<p class="status" role="alert">{failure}</p>
	{:else if passed}
		<p class="status" role="status">Connection works.</p>
	{/if}

	<div class="setup-acts">
		{#if passed}
			<Button
				variant="primary"
				size="lg"
				shape="capsule"
				loading={saving}
				disabled={skipping.active}
				onclick={save}
			>
				Save and continue
			</Button>
		{:else}
			<Button
				variant="primary"
				size="lg"
				shape="capsule"
				loading={testing}
				disabled={skipping.active}
				onclick={test}
			>
				Test connection
			</Button>
		{/if}
		<Button
			variant="ghost"
			size="lg"
			shape="capsule"
			loading={skipping.active}
			disabled={saving || testing}
			onclick={() => skipping.run(onSkip)}
		>
			Skip for now
		</Button>
	</div>
</section>
