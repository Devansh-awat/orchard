<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { Loader2, Shield, Lock } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
	import { apiFetch, initApiBase } from '$lib/stores';
	import { env } from '$env/dynamic/public';

	interface Branding {
		organizationId: string;
		name: string;
		slug: string;
		avatarUrl?: string;
		ssoEnabled: boolean;
		ssoEnforced: boolean;
		provider: 'oidc' | 'saml' | null;
		loginLogoUrl?: string;
		loginPrimaryColor?: string;
		loginBgColor?: string;
		loginWelcomeText?: string;
	}

	let branding = $state<Branding | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let ssoLoading = $state(false);

	// OTP fallback state (when SSO is not enforced)
	let showOtpFallback = $state(false);
	let otpEmail = $state('');
	let otpCode = $state('');
	let otpStep = $state<'email' | 'code'>('email');
	let otpRequesting = $state(false);
	let otpVerifying = $state(false);
	let otpError = $state<string | null>(null);
	let otpMessage = $state<string | null>(null);

	const primaryColor = $derived(branding?.loginPrimaryColor || '#6366f1');
	const bgColor = $derived(branding?.loginBgColor || '#0a0a0f');

	onMount(async () => {
		if (!browser) return;

		const apiBase = env.PUBLIC_API_BASE || '';
		initApiBase(apiBase);

		// Check URL error params
		const urlError = $page.url.searchParams.get('error');
		if (urlError) {
			error = decodeURIComponent(urlError);
		}

		// Get branding from server-side load
		const pageData = $page.data;
		if (pageData?.branding) {
			branding = pageData.branding as Branding;
		} else {
			// Client-side fallback: detect subdomain from hostname
			const host = window.location.hostname;
			const baseDomain = env.PUBLIC_BASE_DOMAIN || '';
			if (baseDomain && host.endsWith(`.${baseDomain}`)) {
				const subdomain = host.replace(`.${baseDomain}`, '');
				try {
					const res = await apiFetch(`/apiv1/sso/subdomain/${subdomain}`);
					if (res.ok) {
						branding = await res.json();
					}
				} catch {
					// ignore
				}
			}
		}

		loading = false;
	});

	function startSsoLogin() {
		if (!branding) return;
		ssoLoading = true;

		const apiBase = env.PUBLIC_API_BASE || '';
		window.location.href = `${apiBase}/apiv1/sso/${branding.organizationId}/login`;
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
				throw new Error(data?.message || 'Could not send code.');
			}

			otpStep = 'code';
			otpMessage = data?.message || 'Check your inbox for a 6-digit code.';
			otpCode = '';
		} catch (err) {
			otpError = err instanceof Error ? err.message : 'Failed to send code.';
		} finally {
			otpRequesting = false;
		}
	}

	async function verifyOtp() {
		if (otpVerifying) return;

		const email = otpEmail.trim().toLowerCase();
		const code = otpCode.trim();

		if (!code || code.length !== 6) {
			otpError = 'Enter the 6-digit code.';
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
				throw new Error(data?.message || 'Invalid code.');
			}

			// Redirect to org dashboard
			if (branding) {
				window.location.href = `/${branding.slug}`;
			} else {
				window.location.href = '/';
			}
		} catch (err) {
			otpError = err instanceof Error ? err.message : 'Verification failed.';
		} finally {
			otpVerifying = false;
		}
	}
</script>

<div class="sso-page" style="--sso-primary: {primaryColor}; --sso-bg: {bgColor};">
	<div class="sso-bg">
		<div class="sso-orb sso-orb-1"></div>
		<div class="sso-orb sso-orb-2"></div>
	</div>

	{#if loading}
		<div class="sso-card">
			<div class="sso-loading">
				<Loader2 class="h-6 w-6 animate-spin" />
			</div>
		</div>
	{:else if !branding}
		<div class="sso-card">
			<div class="sso-card-icon">
				<Lock size={24} />
			</div>
			<h2 class="sso-title">Organization not found</h2>
			<p class="sso-subtitle">This subdomain is not configured for SSO login.</p>
		</div>
	{:else}
		<div class="sso-card">
			<!-- Logo -->
			{#if branding.loginLogoUrl}
				<img src={branding.loginLogoUrl} alt={branding.name} class="sso-logo" />
			{:else if branding.avatarUrl}
				<img src={branding.avatarUrl} alt={branding.name} class="sso-logo" />
			{:else}
				<div class="sso-card-icon" style="background: {primaryColor}20; color: {primaryColor};">
					<Shield size={28} />
				</div>
			{/if}

			<h2 class="sso-title">
				{branding.loginWelcomeText || `Sign in to ${branding.name}`}
			</h2>

			{#if error}
				<div class="sso-error">{error}</div>
			{/if}

			{#if branding.ssoEnabled}
				<Button
					variant="primary"
					class="w-full"
					onclick={startSsoLogin}
					loading={ssoLoading}
					style="background: {primaryColor};"
				>
					<Shield class="h-4 w-4" />
					Sign in with SSO
				</Button>

				{#if !branding.ssoEnforced}
					{#if !showOtpFallback}
						<Button
							variant="ghost"
							size="sm"
							onclick={() => {
								showOtpFallback = true;
							}}
						>
							Sign in with email instead
						</Button>
					{/if}
				{/if}
			{:else}
				<p class="sso-subtitle">SSO is not yet enabled for this organization.</p>
			{/if}

			<!-- OTP fallback -->
			{#if showOtpFallback && !branding.ssoEnforced}
				<div class="sso-divider"><span>or continue with email</span></div>

				<form
					class="sso-form"
					novalidate
					onsubmit={(e) => {
						e.preventDefault();
						if (otpStep === 'email') requestOtp();
						else verifyOtp();
					}}
				>
					<label class="sso-label" for="sso-otp-email">Email address</label>
					<input
						class="sso-input"
						type="email"
						id="sso-otp-email"
						placeholder="you@example.com"
						bind:value={otpEmail}
						autocomplete="email"
					/>

					{#if otpStep === 'code'}
						<label class="sso-label" for="sso-otp-code">Verification code</label>
						<div class="sso-otp-row">
							<input
								class="sso-input sso-code"
								type="text"
								inputmode="numeric"
								maxlength="6"
								placeholder="000000"
								id="sso-otp-code"
								bind:value={otpCode}
								autocomplete="one-time-code"
							/>
							<Button
								variant="secondary"
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
						<p class="sso-error-text">{otpError}</p>
					{/if}
					{#if otpMessage}
						<p class="sso-success-text">{otpMessage}</p>
					{/if}

					<Button
						variant="secondary"
						class="w-full"
						type="submit"
						loading={otpRequesting || otpVerifying}
					>
						{otpStep === 'email' ? 'Send code' : 'Verify'}
					</Button>
				</form>
			{/if}

			<p class="sso-footer">
				Powered by <a href="https://orchard.my" target="_blank" rel="noopener">Orchard</a>
			</p>
		</div>
	{/if}
</div>

<style>
	.sso-page {
		min-height: 100vh;
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--sso-bg);
		position: relative;
		overflow: hidden;
	}

	.sso-bg {
		position: fixed;
		inset: 0;
		pointer-events: none;
		z-index: 0;
	}

	.sso-orb {
		position: absolute;
		border-radius: 50%;
		filter: blur(120px);
		opacity: 0.15;
	}

	.sso-orb-1 {
		width: 500px;
		height: 500px;
		background: var(--sso-primary);
		top: -100px;
		right: -100px;
	}

	.sso-orb-2 {
		width: 400px;
		height: 400px;
		background: var(--sso-primary);
		bottom: -80px;
		left: -80px;
		opacity: 0.1;
	}

	.sso-card {
		position: relative;
		z-index: 1;
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 1rem;
		padding: 2.5rem;
		width: 100%;
		max-width: 420px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1.25rem;
		backdrop-filter: blur(24px);
		--control-bg: rgba(255, 255, 255, 0.08);
		--control-hover-bg: rgba(255, 255, 255, 0.12);
		--control-text: rgba(255, 255, 255, 0.9);
		--surface-border: rgba(255, 255, 255, 0.1);
		--surface-muted: rgba(255, 255, 255, 0.5);
		--center-channel-color: rgba(255, 255, 255, 0.9);
	}

	.sso-loading {
		padding: 2rem;
		color: rgba(255, 255, 255, 0.5);
	}

	.sso-logo {
		width: 56px;
		height: 56px;
		border-radius: 0.75rem;
		object-fit: cover;
	}

	.sso-card-icon {
		width: 56px;
		height: 56px;
		border-radius: 0.75rem;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(255, 255, 255, 0.06);
		color: rgba(255, 255, 255, 0.7);
	}

	.sso-title {
		font-size: 1.25rem;
		font-weight: 600;
		color: rgba(255, 255, 255, 0.95);
		text-align: center;
		margin: 0;
	}

	.sso-subtitle {
		font-size: 0.875rem;
		color: rgba(255, 255, 255, 0.5);
		text-align: center;
		margin: 0;
	}

	.sso-error {
		background: rgba(239, 68, 68, 0.1);
		border: 1px solid rgba(239, 68, 68, 0.2);
		border-radius: 0.5rem;
		padding: 0.75rem 1rem;
		font-size: 0.8rem;
		color: #fca5a5;
		width: 100%;
		text-align: center;
	}

	.sso-divider {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		color: rgba(255, 255, 255, 0.3);
		font-size: 0.75rem;
	}

	.sso-divider::before,
	.sso-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: rgba(255, 255, 255, 0.08);
	}

	.sso-form {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.sso-label {
		font-size: 0.75rem;
		font-weight: 500;
		color: rgba(255, 255, 255, 0.6);
	}

	.sso-input {
		width: 100%;
		padding: 0.625rem 0.75rem;
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 0.5rem;
		color: rgba(255, 255, 255, 0.9);
		font-size: 0.875rem;
		outline: none;
		transition: border-color 0.15s;
	}

	.sso-input:focus {
		border-color: var(--sso-primary);
	}

	.sso-input::placeholder {
		color: rgba(255, 255, 255, 0.25);
	}

	.sso-otp-row {
		display: flex;
		gap: 0.5rem;
	}

	.sso-code {
		font-family: monospace;
		letter-spacing: 0.25em;
		text-align: center;
		flex: 1;
	}

	.sso-error-text {
		font-size: 0.8rem;
		color: #fca5a5;
		margin: 0;
	}

	.sso-success-text {
		font-size: 0.8rem;
		color: #86efac;
		margin: 0;
	}

	.sso-footer {
		font-size: 0.7rem;
		color: rgba(255, 255, 255, 0.25);
		margin-top: 0.5rem;
	}

	.sso-footer a {
		color: rgba(255, 255, 255, 0.4);
		text-decoration: none;
	}

	.sso-footer a:hover {
		color: rgba(255, 255, 255, 0.6);
	}
</style>
