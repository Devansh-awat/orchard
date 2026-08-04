<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { user, isSignedIn, apiFetch } from '$lib/stores';
	import { Loader2, KeyRound } from 'lucide-svelte';

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

<div class="login-page">
	<div class="login-bg">
		<div class="login-orb login-orb-1"></div>
		<div class="login-orb login-orb-2"></div>
		<div class="login-orb login-orb-3"></div>
		<div class="login-orb login-orb-4"></div>
		<div class="login-grid-overlay"></div>
	</div>

	<div class="login-container">
		<div class="login-hero">
			<div class="login-hero-content">
				<img src="/logo/logofulldm.svg" alt="Orchard" class="login-hero-logo" />
				<p class="login-hero-subtitle">
					<strong>{clientName}</strong> is requesting access to your Orchard account via MCP.
				</p>
				{#if redirectUri}
					<div class="mcp-consent-details">
						<p class="mcp-consent-label">
							After you approve, your authorization code will be sent to:
						</p>
						<p class="mcp-consent-host">{redirectHost || redirectUri}</p>
						<p class="mcp-consent-uri">{redirectUri}</p>
						<p class="mcp-consent-warning">
							Only approve if you recognize this destination. Anyone with access to that URL can use
							your Orchard account.
						</p>
					</div>
				{/if}
			</div>
		</div>

		<div class="login-form-side">
			{#if error}
				<div class="login-panel" style="text-align: center;">
					<div class="login-panel-header">
						<h2 class="login-panel-title">Authorization Failed</h2>
					</div>
					<p class="login-error">{error}</p>
				</div>
			{:else if authorized}
				<div class="login-panel" style="text-align: center;">
					<div class="login-panel-header">
						<h2 class="login-panel-title">Authorized</h2>
					</div>
					<p class="login-success">Redirecting back to the application...</p>
				</div>
			{:else if $isSignedIn}
				<div class="login-panel">
					<div class="login-panel-header">
						<h2 class="login-panel-title">Authorize MCP Access</h2>
						<p class="login-panel-desc">Signed in as <strong>{$user?.email}</strong></p>
					</div>

					<button class="login-primary" onclick={completeAuthorization} disabled={authorizing}>
						{#if authorizing}
							<Loader2 class="h-4 w-4 animate-spin" />
						{/if}
						{authorizing ? 'Authorizing...' : 'Authorize'}
					</button>
				</div>
			{:else}
				<div class="login-panel">
					<div class="login-panel-header">
						<h2 class="login-panel-title">Sign in to authorize</h2>
					</div>

					<button class="login-primary" onclick={signInWithHackClub}>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline
								points="10 17 15 12 10 7"
							/><line x1="15" y1="12" x2="3" y2="12" /></svg
						>
						Continue with Hack Club
					</button>

					<div class="login-divider">
						<span>or continue with email</span>
					</div>

					<form
						class="login-form"
						novalidate
						onsubmit={(e) => {
							e.preventDefault();
							if (otpStep === 'email') requestOtp();
							else verifyOtp();
						}}
					>
						<label class="login-label" for="otp-email">Email address</label>
						<input
							class="input login-input"
							type="email"
							placeholder="you@example.com"
							id="otp-email"
							bind:value={otpEmail}
							autocomplete="email"
							required
						/>
						{#if otpStep === 'code'}
							<label class="login-label" for="otp-code">Verification code</label>
							<div class="login-otp-row">
								<input
									class="input login-input login-code"
									type="text"
									inputmode="numeric"
									maxlength="6"
									placeholder="000000"
									id="otp-code"
									bind:value={otpCode}
									autocomplete="one-time-code"
								/>
								<button
									type="button"
									class="login-back"
									onclick={() => {
										otpStep = 'email';
										otpCode = '';
										otpMessage = null;
									}}
								>
									Back
								</button>
							</div>
						{/if}
						{#if otpError}
							<p class="login-error">{otpError}</p>
						{/if}
						{#if otpMessage}
							<p class="login-success">{otpMessage}</p>
						{/if}
						<button
							class="btn btn-primary login-submit"
							type="submit"
							disabled={otpRequesting || otpVerifying}
						>
							{#if otpRequesting || otpVerifying}
								<Loader2 class="h-4 w-4 animate-spin" />
							{/if}
							{otpStep === 'email' ? 'Send code' : 'Verify & Authorize'}
						</button>
					</form>

					{#if passkeySupported}
						<div class="login-passkey">
							<label class="login-label" for="passkey-email">Passkey sign in</label>
							<input
								class="input login-input"
								type="email"
								placeholder="Email (optional)"
								id="passkey-email"
								bind:value={passkeyEmail}
							/>
							<button
								class="btn btn-secondary login-passkey-btn"
								type="button"
								onclick={signInWithPasskey}
								disabled={passkeyLoading}
							>
								{#if passkeyLoading}
									<Loader2 class="h-4 w-4 animate-spin" />
								{/if}
								<KeyRound class="h-4 w-4" />
								Sign in with Passkey
							</button>
							{#if passkeyError}
								<p class="login-error">{passkeyError}</p>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.mcp-consent-details {
		margin-top: 1.5rem;
		padding: 1rem;
		border-radius: var(--radius-sm);
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid rgba(255, 255, 255, 0.1);
		text-align: left;
	}
	.mcp-consent-label {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		opacity: 0.75;
		margin: 0 0 0.5rem 0;
	}
	.mcp-consent-host {
		font-size: var(--text-title-3);
		line-height: var(--lh-title-3);
		font-weight: 600;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		margin: 0 0 0.25rem 0;
		word-break: break-all;
	}
	.mcp-consent-uri {
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		opacity: 0.6;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		margin: 0 0 0.75rem 0;
		word-break: break-all;
	}
	.mcp-consent-warning {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		opacity: 0.8;
		margin: 0;
		padding-top: 0.75rem;
		border-top: 1px solid rgba(255, 255, 255, 0.08);
	}
</style>
