<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { KeyRound } from 'lucide-svelte';
	import { Button, Input } from '$lib/components/ui';
	import Turnstile from '$lib/components/Turnstile.svelte';
	import { apiFetch, authConfig } from '$lib/stores';
	import type { User } from '$lib/stores';

	let {
		email = $bindable(''),
		initialCode = '',
		onAuthenticated,
		onBlocked,
		onSsoRedirect
	}: {
		email?: string;
		// A code that arrived in the URL, from a link `orchardctl login` minted
		// on the host. Redeemed on mount so the link is one click, not a
		// copy-paste into the form.
		initialCode?: string;
		onAuthenticated: (message: string, user?: User) => void | Promise<void>;
		onBlocked?: (reason: 'private_beta' | 'signups_disabled') => void;
		// Called when the typed address belongs to an org that runs its own IdP.
		onSsoRedirect?: (email: string) => Promise<boolean>;
	} = $props();

	type Mode = 'start' | 'passkey' | 'code' | 'password';

	let mode = $state<Mode>('start');
	let code = $state('');
	let password = $state('');
	let checking = $state(false);
	let requesting = $state(false);
	let verifying = $state(false);
	let passkeyLoading = $state(false);
	let message = $state<string | null>(null);
	let error = $state<string | null>(null);
	let passkeySupported = $state(false);

	let siteKey = $state<string | null>(null);
	let botToken = $state<string | null>(null);
	let botError = $state<string | null>(null);
	let widget = $state<{ reset: () => void } | null>(null);

	const botBlocked = $derived(!!siteKey && !botToken);

	let configLoaded = false;
	let pendingAutoVerify = false;

	function maybeAutoVerify() {
		if (!pendingAutoVerify || !configLoaded) return;
		if (siteKey && !botToken) return;
		pendingAutoVerify = false;
		verifyOtp();
	}

	function setMode(next: Mode) {
		mode = next;
		botToken = null;
	}

	function botHeaders(): Record<string, string> {
		return botToken ? { 'x-turnstile-token': botToken } : {};
	}

	function spendBotToken() {
		botToken = null;
		widget?.reset();
	}

	onMount(() => {
		passkeySupported =
			browser && window.isSecureContext && typeof window.PublicKeyCredential !== 'undefined';

		authConfig
			.load()
			.then((config) => {
				siteKey = config.turnstileSiteKey;
			})
			.catch(() => {
				siteKey = null;
			})
			.finally(() => {
				configLoaded = true;
				maybeAutoVerify();
			});

		if (initialCode && email) {
			code = initialCode;
			setMode('code');
			message = 'Signing you in.';
			pendingAutoVerify = true;
			maybeAutoVerify();
		}
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
				headers: { 'Content-Type': 'application/json', ...botHeaders() },
				body: JSON.stringify({ email: address })
			});
			spendBotToken();
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data?.message || 'Could not send the OTP email.');

			setMode('code');
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

			let methods = { passkey: false, password: false };
			try {
				const response = await apiFetch(`/apiv1/auth/methods?email=${encodeURIComponent(address)}`);
				const data = await response.json().catch(() => ({}));
				methods = { passkey: Boolean(data?.passkey), password: Boolean(data?.password) };
			} catch {
				methods = { passkey: false, password: false };
			}

			if (methods.passkey && passkeySupported) {
				setMode('passkey');
				await signInWithPasskey();
			} else if (methods.password) {
				setMode('password');
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
				headers: { 'Content-Type': 'application/json', ...botHeaders() },
				body: JSON.stringify({ email: address, code: value })
			});
			spendBotToken();
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

	async function signInWithPassword() {
		if (verifying) return;
		if (!password) {
			error = 'Enter your password.';
			return;
		}

		verifying = true;
		error = null;
		try {
			const response = await apiFetch('/apiv1/auth/password', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...botHeaders() },
				body: JSON.stringify({ email: email.trim().toLowerCase(), password })
			});
			spendBotToken();
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				if (blockedFrom(response.status, data)) return;
				throw new Error(data?.message || 'Invalid email or password.');
			}
			const data = await response.json().catch(() => null);
			password = '';
			await onAuthenticated('Signed in', data?.user);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not sign in.';
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
		setMode('start');
		code = '';
		password = '';
		message = null;
		error = null;
	}
</script>

{#snippet botCheck()}
	{#if siteKey}
		<Turnstile
			bind:this={widget}
			{siteKey}
			action="signin"
			bind:token={botToken}
			bind:error={botError}
			onsolved={maybeAutoVerify}
		/>
		{#if botError}
			<p class="lg-error">{botError}</p>
		{/if}
	{/if}
{/snippet}

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
		{@render botCheck()}
		<Button
			variant="secondary"
			type="submit"
			loading={checking || requesting}
			disabled={botBlocked}
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
		{@render botCheck()}
		<Button
			variant="ghost"
			class="lg-wide"
			loading={requesting}
			disabled={botBlocked}
			onclick={requestOtp}
		>
			Email me a code instead
		</Button>
		<Button variant="ghost" size="sm" class="lg-center" onclick={reset}>Back</Button>
	</div>
{:else if mode === 'password'}
	<form
		class="lg-form"
		novalidate
		onsubmit={(e) => {
			e.preventDefault();
			signInWithPassword();
		}}
	>
		<div class="lg-step-head">
			<p class="lg-step-title">{email}</p>
		</div>
		<label class="lg-label" for="login-password">Password</label>
		<Input
			type="password"
			name="password"
			id="login-password"
			bind:value={password}
			autocomplete="current-password"
			class="lg-wide"
		/>
		{#if error}
			<p class="lg-error">{error}</p>
		{/if}
		{@render botCheck()}
		<Button
			variant="secondary"
			type="submit"
			loading={verifying}
			disabled={botBlocked}
			class="lg-wide lg-action"
		>
			Sign in
		</Button>
		<Button
			variant="ghost"
			class="lg-wide"
			loading={requesting}
			disabled={botBlocked}
			onclick={requestOtp}
		>
			Email me a code instead
		</Button>
		<Button variant="ghost" size="sm" class="lg-center" onclick={reset}>Back</Button>
	</form>
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
		{@render botCheck()}
		<Button
			variant="secondary"
			type="submit"
			loading={verifying}
			disabled={botBlocked}
			class="lg-wide lg-action"
		>
			Verify
		</Button>
		<Button variant="ghost" size="sm" class="lg-center" onclick={reset}>Back</Button>
	</form>
{/if}
