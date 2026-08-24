<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { user, isSignedIn, apiFetch } from '$lib/stores';
	import { KeyRound } from 'lucide-svelte';
	import { Button, Input } from '$lib/components/ui';
	import { motionStagger } from '$lib/utils/motion.svelte';

	let mcpState = $derived($page.url.searchParams.get('mcp_state') || '');
	let mcpServer = $derived($page.url.searchParams.get('mcp_server') || '');
	let clientName = $derived($page.url.searchParams.get('client_name') || 'An application');
	let redirectUri = $derived($page.url.searchParams.get('redirect_uri') || '');
	let redirectHost = $derived.by(() => {
		if (!redirectUri) return '';
		try {
			return new URL(redirectUri).host;
		} catch {
			return '';
		}
	});

	let error = $state<string | null>(null);
	let authorizing = $state(false);
	let authorized = $state(false);

	// OTP login state
	let otpEmail = $state('');
	let otpCode = $state('');
	let otpStep = $state<'email' | 'code'>('email');
	let otpRequesting = $state(false);
	let otpVerifying = $state(false);
	let otpMessage = $state<string | null>(null);
	let otpError = $state<string | null>(null);

	// Passkey state
	let passkeyEmail = $state('');
	let passkeyLoading = $state(false);
	let passkeyError = $state<string | null>(null);
	let passkeySupported = $state(false);

	onMount(() => {
		if (!mcpState || !mcpServer) {
			error = 'Invalid authorization request. Missing parameters.';
			return;
		}

		if (browser && typeof window !== 'undefined') {
			passkeySupported =
				window.isSecureContext && typeof window.PublicKeyCredential !== 'undefined';
		}
	});

	async function completeAuthorization() {
		if (authorizing) return;
		authorizing = true;
		error = null;

		try {
			const tokenRes = await apiFetch('/apiv1/auth/mcp-token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' }
			});

			if (!tokenRes.ok) {
				throw new Error('Failed to get authorization token. Please sign in first.');
			}

			const { token } = await tokenRes.json();

			const completeRes = await fetch(`${mcpServer}/authorize/complete`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mcp_state: mcpState,
					session_token: token
				})
			});

			if (!completeRes.ok) {
				const data = await completeRes.json().catch(() => ({}));
				throw new Error(data?.error || 'Authorization failed.');
			}

			const { redirect_url } = await completeRes.json();
			authorized = true;
			window.location.href = redirect_url;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Authorization failed.';
		} finally {
			authorizing = false;
		}
	}

	async function requestOtp() {
		if (otpRequesting) return;

		const email = otpEmail.trim().toLowerCase();
		if (!email) {
			otpError = 'Enter your email address.';
			return;
		}

		otpRequesting = true;
		otpError = null;

		try {
			const response = await apiFetch('/apiv1/auth/otp/request', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email })
			});

			const data = await response.json().catch(() => ({}));

			if (!response.ok) {
				throw new Error(data?.message || 'Could not send the OTP email.');
			}

			otpStep = 'code';
			otpMessage = data?.message || 'Check your inbox for a 6-digit code.';
			otpCode = '';
		} catch (err) {
			otpError = err instanceof Error ? err.message : 'Failed to send OTP email.';
		} finally {
			otpRequesting = false;
		}
	}

	async function verifyOtp() {
		if (otpVerifying) return;

		const email = otpEmail.trim().toLowerCase();
		const code = otpCode.trim();

		if (!code || code.length !== 6) {
			otpError = 'Enter the 6-digit code we sent you.';
			return;
		}

		otpVerifying = true;
		otpError = null;

		try {
			const response = await apiFetch('/apiv1/auth/otp/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, code })
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || 'Invalid OTP code.');
			}

			const data = await response.json().catch(() => null);
			if (data?.user) {
				user.set(data.user);
			}

			await completeAuthorization();
		} catch (err) {
			otpError = err instanceof Error ? err.message : 'Failed to verify code.';
		} finally {
			otpVerifying = false;
		}
	}

	async function signInWithPasskey() {
		if (passkeyLoading) return;
		passkeyLoading = true;
		passkeyError = null;

		try {
			const response = await apiFetch('/apiv1/auth/passkey/authenticate/options', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: passkeyEmail.trim() || undefined })
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
				throw new Error(data?.message || 'Passkey authentication failed.');
			}

			const data = await verifyResponse.json().catch(() => null);
			if (data?.user) {
				user.set(data.user);
			}

			await completeAuthorization();
		} catch (err) {
			if (err instanceof Error && err.name === 'NotAllowedError') {
				passkeyError = 'Passkey request was cancelled.';
			} else {
				passkeyError = err instanceof Error ? err.message : 'Passkey sign-in failed.';
			}
		} finally {
			passkeyLoading = false;
		}
	}

	function signInWithHackClub() {
		if (browser) {
			sessionStorage.setItem('mcp_authorize_state', mcpState);
			sessionStorage.setItem('mcp_authorize_server', mcpServer);
			user.signIn();
		}
	}

	onMount(async () => {
		if (!browser) return;

		const savedState = sessionStorage.getItem('mcp_authorize_state');
		const savedServer = sessionStorage.getItem('mcp_authorize_server');

		if ($isSignedIn && savedState && savedServer) {
			sessionStorage.removeItem('mcp_authorize_state');
			sessionStorage.removeItem('mcp_authorize_server');

			if (mcpState && mcpServer) {
				await completeAuthorization();
			}
		}
	});
</script>

<svelte:head>
	<title>Authorize MCP Access - Orchard</title>
</svelte:head>

<div class="consent-page">
	<div class="consent-stack">
		<div class="consent-brand" {@attach motionStagger({ index: 0 })}>
			<img src="/logo/logofull.svg" alt="Orchard" class="consent-logo logo-light" />
			<img src="/logo/logofulldm.svg" alt="Orchard" class="consent-logo logo-dark" />
		</div>

		{#if error}
			<h1 class="consent-title" {@attach motionStagger({ index: 1 })}>Authorization failed</h1>
			<p class="consent-error" {@attach motionStagger({ index: 2 })}>{error}</p>
		{:else if authorized}
			<h1 class="consent-title" {@attach motionStagger({ index: 1 })}>Authorized</h1>
			<p class="consent-subtitle" {@attach motionStagger({ index: 2 })}>
				Redirecting back to {clientName}...
			</p>
		{:else}
			<h1 class="consent-title" {@attach motionStagger({ index: 1 })}>
				Authorize MCP access
			</h1>
			<p class="consent-subtitle" {@attach motionStagger({ index: 2 })}>
				<strong>{clientName}</strong> is requesting access to your Orchard account.
			</p>

			{#if redirectUri}
				<div class="consent-details" {@attach motionStagger({ index: 3 })}>
					<p class="consent-label">After you approve, your authorization code will be sent to:</p>
					<p class="consent-host">{redirectHost || redirectUri}</p>
					<p class="consent-uri">{redirectUri}</p>
					<p class="consent-warning">
						Only approve if you recognize this destination. Anyone with access to that URL can use
						your Orchard account.
					</p>
				</div>
			{/if}

			<div class="consent-action" {@attach motionStagger({ index: 4 })}>
				{#if $isSignedIn}
					<p class="consent-identity">Signed in as <strong>{$user?.email}</strong></p>
					<Button
						variant="primary"
						class="w-full"
						onclick={completeAuthorization}
						loading={authorizing}
					>
						{authorizing ? 'Authorizing...' : 'Authorize'}
					</Button>
				{:else}
					<Button variant="primary" class="w-full" onclick={signInWithHackClub}>
						Continue with Hack Club
					</Button>

					<div class="consent-divider"><span>or continue with email</span></div>

					<form
						class="consent-form"
						novalidate
						onsubmit={(e) => {
							e.preventDefault();
							if (otpStep === 'email') requestOtp();
							else verifyOtp();
						}}
					>
						<Input
							type="email"
							placeholder="you@example.com"
							id="otp-email"
							bind:value={otpEmail}
							autocomplete="email"
							error={!!otpError}
							required
						/>
						{#if otpStep === 'code'}
							<div class="consent-otp-row">
								<Input
									type="text"
									class="consent-code"
									inputmode="numeric"
									maxlength="6"
									placeholder="000000"
									id="otp-code"
									bind:value={otpCode}
									autocomplete="one-time-code"
									error={!!otpError}
								/>
								<Button
									variant="ghost"
									type="button"
									onclick={() => {
										otpStep = 'email';
										otpCode = '';
										otpMessage = null;
									}}
								>
									Back
								</Button>
							</div>
						{/if}
						{#if otpError}
							<p class="consent-error">{otpError}</p>
						{/if}
						{#if otpMessage}
							<p class="consent-success">{otpMessage}</p>
						{/if}
						<Button
							variant="primary"
							class="w-full"
							type="submit"
							loading={otpRequesting || otpVerifying}
						>
							{otpStep === 'email' ? 'Send code' : 'Verify and authorize'}
						</Button>
					</form>

					{#if passkeySupported}
						<div class="consent-divider"><span>or use a passkey</span></div>
						<div class="consent-form">
							<Input
								type="email"
								placeholder="Email (optional)"
								id="passkey-email"
								bind:value={passkeyEmail}
							/>
							<Button
								variant="secondary"
								class="w-full"
								type="button"
								onclick={signInWithPasskey}
								loading={passkeyLoading}
							>
								<KeyRound class="h-4 w-4" />
								Sign in with passkey
							</Button>
							{#if passkeyError}
								<p class="consent-error">{passkeyError}</p>
							{/if}
						</div>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.consent-page {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem 1.5rem;
		background: var(--bg-app);
	}

	.consent-stack {
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 100%;
		max-width: 22rem;
		text-align: center;
	}

	.consent-brand {
		margin-bottom: 1.75rem;
	}

	.consent-logo {
		height: 1.75rem;
		width: auto;
	}

	.consent-title {
		font-size: var(--text-title-3);
		line-height: var(--lh-title-3);
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--text-default);
		margin: 0 0 0.5rem;
	}

	.consent-subtitle {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
		margin: 0;
	}

	.consent-subtitle strong {
		color: var(--text-default);
		font-weight: 600;
	}

	.consent-details {
		width: 100%;
		margin-top: 1.5rem;
		padding: 1rem;
		border-radius: var(--radius-sm);
		background: var(--bg-surface);
		border: 1px solid var(--border-default);
		text-align: left;
	}

	.consent-label {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
		margin: 0 0 0.5rem;
	}

	.consent-host {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		font-weight: 600;
		font-family: var(--font-mono);
		color: var(--text-default);
		margin: 0 0 0.25rem;
		word-break: break-all;
	}

	.consent-uri {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
		font-family: var(--font-mono);
		margin: 0 0 0.75rem;
		word-break: break-all;
	}

	.consent-warning {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		margin: 0;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border-default);
	}

	.consent-action {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 1.5rem;
	}

	.consent-identity {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--text-muted);
		margin: 0;
	}

	.consent-identity strong {
		color: var(--text-default);
		font-weight: 600;
	}

	.consent-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.consent-otp-row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.consent-otp-row :global(.consent-code) {
		flex: 1;
		min-width: 0;
		text-align: center;
		font-family: var(--font-mono);
		letter-spacing: 0.3em;
	}

	.consent-divider {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
	}

	.consent-divider::before,
	.consent-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--border-default);
	}

	.consent-error {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--status-error);
		margin: 0;
	}

	.consent-success {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--status-success);
		margin: 0;
	}
</style>
