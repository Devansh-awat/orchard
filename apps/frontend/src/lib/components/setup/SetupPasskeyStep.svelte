<script lang="ts">
	import { apiFetch, toasts } from '$lib/stores';
	import {
		registerPasskey,
		passkeysSupported,
		secureContextWarning,
		passkeyErrorMessage
	} from '$lib/utils/passkey';

	let { onDone }: { onDone: () => Promise<void> | void } = $props();

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
			error = 'Those did not match.';
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
				throw new Error(data?.message || 'Could not set the password.');
			}
			password = '';
			confirm = '';
			toasts.add({ title: 'Password set', color: 'success' });
			await onDone();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not set the password.';
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
			<p>It stays on this device. Nothing to remember, nothing to leak.</p>
		{/if}

		<div class="setup-acts">
			<button class="setup-pill" disabled={working} onclick={add}>
				{working ? 'Waiting for your device' : 'Create passkey'}
			</button>
			<button class="setup-ghost" onclick={() => ((choice = 'password'), (error = null))}>
				Set a password instead
			</button>
		</div>
	{:else}
		<h2>Set a password</h2>
		{#if error}
			<p>{error}</p>
		{:else if !passkeyAvailable}
			<p>
				{warning ?? 'This browser cannot create a passkey.'}
				A password works without one, and you can add a passkey later if this instance gets TLS.
			</p>
		{:else}
			<p>Signs in this account without a device to hand. Twelve characters or more.</p>
		{/if}

		<div class="setup-body">
			<input
				type="password"
				bind:value={password}
				placeholder="New password"
				aria-label="New password"
				autocomplete="new-password"
			/>
			<input
				type="password"
				bind:value={confirm}
				placeholder="Again"
				aria-label="Confirm password"
				autocomplete="new-password"
			/>
		</div>

		<div class="setup-acts">
			<button class="setup-pill" disabled={working} onclick={savePassword}>
				{working ? 'Saving' : 'Set password'}
			</button>
			{#if passkeyAvailable}
				<button class="setup-ghost" onclick={() => ((choice = 'passkey'), (error = null))}>
					Use a passkey instead
				</button>
			{/if}
		</div>

		{#if !passkeyAvailable}
			<p class="setup-note">
				Locked out anyway? <code>sudo orchardctl login</code> on the host prints a one-time link.
			</p>
		{/if}
	{/if}
</section>

<style>
	.setup-body input + input {
		margin-top: 0.5rem;
	}
</style>
