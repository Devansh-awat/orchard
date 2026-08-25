<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { KeyRound } from 'lucide-svelte';
	import { Button, Input } from '$lib/components/ui';
	import { apiFetch } from '$lib/stores';
	import type { User } from '$lib/stores';

	let {
		email = $bindable(''),
		onAuthenticated,
		onBlocked,
		onSsoRedirect
	}: {
		email?: string;
		onAuthenticated: (message: string, user?: User) => void | Promise<void>;
		onBlocked?: (reason: 'private_beta' | 'signups_disabled') => void;
		// Called when the typed address belongs to an org that runs its own IdP.
		onSsoRedirect?: (email: string) => Promise<boolean>;
	} = $props();

	type Mode = 'start' | 'passkey' | 'code';

	let mode = $state<Mode>('start');
	let code = $state('');
	let checking = $state(false);
	let requesting = $state(false);
	let verifying = $state(false);
	let passkeyLoading = $state(false);
	let message = $state<string | null>(null);
	let error = $state<string | null>(null);
	let passkeySupported = $state(false);

	onMount(() => {
		passkeySupported =
			browser && window.isSecureContext && typeof window.PublicKeyCredential !== 'undefined';
	});

	function blockedFrom(status: number, data: { message?: string }) {
		if (
			status === 403 &&
			(data?.message === 'private_beta' || data?.message === 'signups_disabled')
		) {
			onBlocked?.(data.message);
			return true;
		}
		return false;
	}

	async function requestOtp() {
		if (requesting) return;
		const address = email.trim().toLowerCase();
		if (!address) {
			error = 'Enter the email address you use with Orchard.';
			return;
		}

		requesting = true;
		error = null;
		try {
			const response = await apiFetch('/apiv1/auth/otp/request', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: address })
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data?.message || 'Could not send the OTP email.');

			mode = 'code';
			message = data?.message || 'Check your inbox for a 6-digit code.';
			code = '';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to send OTP email.';
		} finally {
			requesting = false;
		}
	}

	async function continueWithEmail() {
		if (checking || requesting) return;
		const address = email.trim().toLowerCase();
		if (!address) {
			error = 'Enter the email address you use with Orchard.';
			return;
		}

		checking = true;
		error = null;
		try {
			if (onSsoRedirect && (await onSsoRedirect(address))) return;

			let hasPasskeys = false;
			if (passkeySupported) {
				try {
					const response = await apiFetch(
						`/apiv1/auth/passkey/check?email=${encodeURIComponent(address)}`
					);
					const data = await response.json().catch(() => ({}));
					hasPasskeys = Boolean(data?.hasPasskeys);
				} catch {
					hasPasskeys = false;
				}
			}

			if (hasPasskeys) {
				mode = 'passkey';
				await signInWithPasskey();
			} else {
				await requestOtp();
			}
		} finally {
			checking = false;
		}
	}

	async function verifyOtp() {
		if (verifying) return;
		const address = email.trim().toLowerCase();
		const value = code.trim();

		if (!value || value.length !== 6) {
			error = 'Enter the 6-digit code we sent you.';
			return;
		}

		verifying = true;
		error = null;
		try {
			const response = await apiFetch('/apiv1/auth/otp/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: address, code: value })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				if (blockedFrom(response.status, data)) return;
				throw new Error(data?.message || 'Invalid OTP code.');
			}
			const data = await response.json().catch(() => null);
			await onAuthenticated('Signed in with your email', data?.user);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to verify code.';
		} finally {
			verifying = false;
		}
	}

	async function signInWithPasskey() {
		if (passkeyLoading) return;
		if (!browser || !window.isSecureContext || !window.PublicKeyCredential) {
			error = 'Passkeys are not available in this browser.';
			return;
		}

		passkeyLoading = true;
		error = null;
		try {
			const response = await apiFetch('/apiv1/auth/passkey/authenticate/options', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: email.trim() || undefined })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || 'Could not start passkey authentication.');
			}

			const options = await response.json();
			const { startAuthentication } = await import('@simplewebauthn/browser');
			const credential = await startAuthentication({ optionsJSON: options });

			const verifyResponse = await apiFetch('/apiv1/auth/passkey/authenticate/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ response: credential })
			});
			if (!verifyResponse.ok) {
				const data = await verifyResponse.json().catch(() => ({}));
				if (blockedFrom(verifyResponse.status, data)) return;
				throw new Error(data?.message || 'Passkey authentication failed.');
			}

			const data = await verifyResponse.json().catch(() => null);
			await onAuthenticated('Signed in with your passkey', data?.user);
		} catch (err) {
			if (err instanceof Error && err.name === 'NotAllowedError') {
				error = 'Passkey request was cancelled.';
			} else {
				error = err instanceof Error ? err.message : 'Passkey sign-in failed.';
			}
		} finally {
			passkeyLoading = false;
		}
	}

	export function reset() {
		mode = 'start';
		code = '';
		message = null;
		error = null;
	}
</script>

{#if mode === 'start'}
	<form
		class="lg-form"
		novalidate
		onsubmit={(e) => {
			e.preventDefault();
			continueWithEmail();
		}}
	>
		<label class="lg-label" for="login-email">Email address</label>
		<Input
			type="email"
			name="email"
			placeholder="you@example.com"
			id="login-email"
			bind:value={email}
			autocomplete="email webauthn"
			required
			class="lg-wide"
		/>
		{#if error}
			<p class="lg-error">{error}</p>
		{/if}
		<Button
			variant="secondary"
			type="submit"
			loading={checking || requesting}
			class="lg-wide lg-action"
		>
			Continue
		</Button>
	</form>
{:else if mode === 'passkey'}
	<div class="lg-step">
		<div class="lg-step-head">
			<p class="lg-step-title">{email}</p>
		</div>
		<Button
			variant="secondary"
			class="lg-wide"
			loading={passkeyLoading}
			onclick={signInWithPasskey}
		>
			{#if !passkeyLoading}
				<KeyRound class="h-4 w-4" />
			{/if}
			Sign in with your passkey
		</Button>
		{#if error}
			<p class="lg-error">{error}</p>
		{/if}
		<Button variant="ghost" class="lg-wide" loading={requesting} onclick={requestOtp}>
			Email me a code instead
		</Button>
		<Button variant="ghost" size="sm" class="lg-center" onclick={reset}>Back</Button>
	</div>
{:else}
	<form
		class="lg-form"
		novalidate
		onsubmit={(e) => {
			e.preventDefault();
			verifyOtp();
		}}
	>
		<div class="lg-step-head">
			<p class="lg-step-title">{email}</p>
			{#if message}
				<p class="lg-step-hint">{message}</p>
			{/if}
		</div>
		<label class="lg-label" for="login-code">Verification code</label>
		<Input
			type="text"
			name="code"
			inputmode="numeric"
			maxlength="6"
			placeholder="000000"
			id="login-code"
			bind:value={code}
			autocomplete="one-time-code"
			class="lg-wide lg-code"
		/>
		{#if error}
			<p class="lg-error">{error}</p>
		{/if}
		<Button variant="secondary" type="submit" loading={verifying} class="lg-wide lg-action">
			Verify
		</Button>
		<Button variant="ghost" size="sm" class="lg-center" onclick={reset}>Back</Button>
	</form>
{/if}
