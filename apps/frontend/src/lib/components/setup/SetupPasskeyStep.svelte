<script lang="ts">
	import { Button, Field, SecretInput } from '$lib/components/ui';
	import { apiFetch, toasts } from '$lib/stores';
	import {
		registerPasskey,
		passkeysSupported,
		secureContextWarning,
		passkeyErrorMessage
	} from '$lib/utils/passkey';

	let { onDone }: { onDone: () => Promise<void> | void } = $props();

	const uid = $props.id();
	const MIN_LENGTH = 12;

	let working = $state(false);
	let error = $state<string | null>(null);
	let password = $state('');
	let confirm = $state('');
	let choice = $state<'passkey' | 'password' | null>(null);

	const warning = $derived(secureContextWarning());
	const supported = $derived(passkeysSupported());
	const passkeyAvailable = $derived(supported && !warning);
	const mode = $derived(choice ?? (passkeyAvailable ? 'passkey' : 'password'));

	async function add() {
		if (working) return;
		working = true;
		error = null;
		try {
			await registerPasskey('This device');
			toasts.add({ title: 'Passkey added', color: 'success' });
			await onDone();
		} catch (err) {
			error = passkeyErrorMessage(err);
		} finally {
			working = false;
		}
	}

	async function savePassword() {
		if (working) return;
		if (password.length < MIN_LENGTH) {
			error = `A password needs at least ${MIN_LENGTH} characters.`;
			return;
		}
		if (password !== confirm) {
			error = "The passwords don't match.";
			return;
		}

		working = true;
		error = null;
		try {
			const response = await apiFetch('/apiv1/auth/password/set', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ password })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || "Couldn't set the password.");
			}
			password = '';
			confirm = '';
			toasts.add({ title: 'Password set', color: 'success' });
			await onDone();
		} catch (err) {
			error = err instanceof Error ? err.message : "Couldn't set the password.";
		} finally {
			working = false;
		}
	}
</script>

<section class="setup-step">
	{#if mode === 'passkey'}
		<h2>Create your passkey</h2>
		{#if error}
			<p>{error}</p>
		{:else}
			<p>It stays on this device, and you have no password to remember.</p>
		{/if}

		<div class="setup-acts">
			<Button variant="primary" size="lg" shape="capsule" loading={working} onclick={add}>
				{working ? 'Waiting for your device' : 'Create passkey'}
			</Button>
			<Button
				variant="ghost"
				size="lg"
				shape="capsule"
				disabled={working}
				onclick={() => ((choice = 'password'), (error = null))}
			>
				Set a password instead
			</Button>
		</div>
	{:else}
		<h2>Set a password</h2>
		{#if error}
			<p>{error}</p>
		{:else if !passkeyAvailable}
			<p>
				{warning ?? "This browser can't create a passkey."}
				Use a password for now. You can add a passkey later if this instance gets TLS.
			</p>
		{:else}
			<p>Lets you sign in without this device. Use at least 12 characters.</p>
		{/if}

		<div class="setup-body setup-fields">
			<Field label="New password" for="{uid}-password">
				<SecretInput
					id="{uid}-password"
					size="lg"
					bind:value={password}
					autocomplete="new-password"
				/>
			</Field>
			<Field label="Confirm password" for="{uid}-confirm">
				<SecretInput
					id="{uid}-confirm"
					size="lg"
					bind:value={confirm}
					autocomplete="new-password"
				/>
			</Field>
		</div>

		<div class="setup-acts">
			<Button variant="primary" size="lg" shape="capsule" loading={working} onclick={savePassword}>
				Set password
			</Button>
			{#if passkeyAvailable}
				<Button
					variant="ghost"
					size="lg"
					shape="capsule"
					disabled={working}
					onclick={() => ((choice = 'passkey'), (error = null))}
				>
					Use a passkey instead
				</Button>
			{/if}
		</div>

		{#if !passkeyAvailable}
			<p class="setup-note">
				If you get locked out, run <code>sudo orchardctl login</code> on the server to get a one-time
				link.
			</p>
		{/if}
	{/if}
</section>
