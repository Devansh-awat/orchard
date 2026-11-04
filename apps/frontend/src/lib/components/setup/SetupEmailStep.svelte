<script lang="ts">
	import { Button, Field, FieldGrid, Input, SecretInput } from '$lib/components/ui';
	import { Pending } from './pending.svelte';
	import { apiFetch, toasts, user } from '$lib/stores';

	let {
		onDone,
		onSkip
	}: {
		onDone: () => Promise<void> | void;
		onSkip: () => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const skipping = new Pending();

	let host = $state('');
	let port = $state('');
	let username = $state('');
	let password = $state('');
	let from = $state('');
	let testing = $state(false);
	let saving = $state(false);
	let passed = $state(false);
	let failure = $state<string | null>(null);

	const to = $derived(($user as { email?: string } | null)?.email ?? '');
	const values = $derived({
		host: host.trim(),
		port: port.trim(),
		user: username.trim(),
		pass: password,
		from: from.trim()
	});

	$effect(() => {
		void values;
		passed = false;
		failure = null;
	});

	async function test() {
		testing = true;
		const sent = values;
		try {
			const response = await apiFetch('/apiv1/admin/instance-config/email/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...sent, to })
			});
			const body = await response.json().catch(() => ({}));
			if (response.ok && body.ok) {
				passed = true;
				failure = null;
			} else {
				passed = false;
				failure = body.message || "Couldn't send the test email.";
			}
		} catch {
			passed = false;
			failure = "Couldn't send the test email.";
		} finally {
			testing = false;
		}
	}

	async function save() {
		saving = true;
		try {
			const response = await apiFetch('/apiv1/admin/instance-config/email', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(values)
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				throw new Error(body?.message || "Couldn't save");
			}
			await onDone();
		} catch (e) {
			toasts.add({ title: e instanceof Error ? e.message : "Couldn't save", color: 'error' });
		} finally {
			saving = false;
		}
	}
</script>

<section class="setup-step">
	<h2>Set up email</h2>
	<p>Optional. Without it, there are no email sign-in codes, and invitations are links you copy.</p>

	<div class="setup-body setup-fields">
		<Field label="SMTP host" for="{uid}-host">
			<Input
				id="{uid}-host"
				size="lg"
				placeholder="smtp.example.com"
				autocomplete="off"
				spellcheck="false"
				bind:value={host}
			/>
		</Field>
		<FieldGrid>
			<Field label="Port" for="{uid}-port">
				<Input
					id="{uid}-port"
					size="lg"
					placeholder="587"
					inputmode="numeric"
					autocomplete="off"
					bind:value={port}
				/>
			</Field>
			<Field label="Username" for="{uid}-username">
				<Input
					id="{uid}-username"
					size="lg"
					autocomplete="off"
					spellcheck="false"
					bind:value={username}
				/>
			</Field>
		</FieldGrid>
		<Field label="Password" for="{uid}-password">
			<SecretInput
				id="{uid}-password"
				size="lg"
				autocomplete="new-password"
				bind:value={password}
			/>
		</Field>
		<Field label="From address" for="{uid}-from">
			<Input
				id="{uid}-from"
				size="lg"
				type="email"
				placeholder="orchard@example.com"
				autocomplete="off"
				spellcheck="false"
				bind:value={from}
			/>
		</Field>
	</div>

	{#if failure}
		<p class="status" role="alert">{failure}</p>
	{:else if passed}
		<p class="status" role="status">Test email sent to {to}.</p>
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
				disabled={!host.trim() || skipping.active}
				onclick={test}
			>
				Send a test email
			</Button>
		{/if}
		{#if failure}
			<Button
				variant="ghost"
				size="lg"
				shape="capsule"
				loading={saving}
				disabled={skipping.active}
				onclick={save}
			>
				Save anyway
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
