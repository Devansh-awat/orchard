<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { Loader2, Shield, Lock, LogIn } from 'lucide-svelte';
	import { apiFetch, initApiBase, user, isSignedIn, isLoaded } from '$lib/stores';
	import { env } from '$env/dynamic/public';

	interface IngressInfo {
		host: string;
		protectionMode: string;
		projectName: string;
	}

	let info = $state<IngressInfo | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let exchanging = $state(false);
	let password = $state('');
	let passwordError = $state<string | null>(null);

	const ingressId = $derived($page.url.searchParams.get('ingressId') || '');
	const returnTo = $derived($page.url.searchParams.get('returnTo') || '');
	const mode = $derived($page.url.searchParams.get('mode') || 'orchard');

	onMount(async () => {
		if (!browser) return;

		const apiBase = env.PUBLIC_API_BASE || '';
		initApiBase(apiBase);

		if (!ingressId || !returnTo) {
			error = 'Invalid protection link.';
			loading = false;
			return;
		}

		try {
			const res = await apiFetch(`/apiv1/auth/protect/info?ingressId=${ingressId}`);
			if (!res.ok) {
				error = 'This deployment is not protected or does not exist.';
				loading = false;
				return;
			}
			info = await res.json();
		} catch {
			error = 'Failed to load deployment info.';
		}

		await user.fetchUser();
		loading = false;

		if (info?.protectionMode === 'orchard' && $isSignedIn) {
			await attemptExchange();
		}
	});

	async function attemptExchange() {
		if (exchanging) return;
		exchanging = true;
		error = null;

		try {
			const res = await apiFetch('/apiv1/auth/protect/exchange/orchard', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ingressId, returnTo })
			});

			if (res.status === 403) {
				error = "You don't have access to this deployment.";
				exchanging = false;
				return;
			}

			if (!res.ok) {
				error = 'Failed to verify access.';
				exchanging = false;
				return;
			}

			const data = await res.json();
			window.location.href = data.redirectUrl;
		} catch {
			error = 'Something went wrong.';
			exchanging = false;
		}
	}

	async function submitPassword() {
		if (exchanging || !password.trim()) return;
		exchanging = true;
		passwordError = null;

		try {
			const res = await apiFetch('/apiv1/auth/protect/exchange/password', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ingressId, password: password.trim(), returnTo })
			});

			if (res.status === 403) {
				passwordError = 'Wrong password.';
				exchanging = false;
				return;
			}

			if (!res.ok) {
				passwordError = 'Something went wrong.';
				exchanging = false;
				return;
			}

			const data = await res.json();
			window.location.href = data.redirectUrl;
		} catch {
			passwordError = 'Something went wrong.';
			exchanging = false;
		}
	}

	function signIn() {
		if (!browser) return;
		const currentUrl = window.location.href;
		sessionStorage.setItem('inviteRedirect', currentUrl);
		const apiBase = env.PUBLIC_API_BASE || '';
		window.location.href = `${apiBase}/apiv1/auth/login`;
	}
</script>

<svelte:head>
	<title>Protected — Orchard</title>
</svelte:head>

<div class="protect-page">
	<div class="protect-bg">
		<div class="protect-orb protect-orb-1"></div>
		<div class="protect-orb protect-orb-2"></div>
		<div class="protect-orb protect-orb-3"></div>
		<div class="protect-grid"></div>
	</div>

	{#if loading}
		<div class="protect-card">
			<div class="protect-loading">
				<Loader2 class="h-6 w-6 animate-spin" />
			</div>
		</div>
	{:else if error && !info}
		<div class="protect-card">
			<div class="protect-icon protect-icon--error">
				<Shield size={24} />
			</div>
			<h2 class="protect-title">{error}</h2>
		</div>
	{:else if info}
		<div class="protect-card">
			<div class="protect-icon">
				<Shield size={24} />
			</div>
			<h2 class="protect-title">Protected deployment</h2>
			<p class="protect-subtitle">
				<span class="protect-host">{info.host}</span> requires authentication.
			</p>

			{#if mode === 'password'}
				<form
					class="protect-form"
					onsubmit={(e) => {
						e.preventDefault();
						submitPassword();
					}}
				>
					<input
						type="password"
						class="input protect-input"
						placeholder="Enter password"
						bind:value={password}
						disabled={exchanging}
						autocomplete="current-password"
					/>
					{#if passwordError}
						<p class="protect-error">{passwordError}</p>
					{/if}
					<button
						class="btn btn-primary protect-submit"
						type="submit"
						disabled={exchanging || !password.trim()}
					>
						{#if exchanging}
							<Loader2 class="h-4 w-4 animate-spin" />
						{:else}
							<Lock size={16} />
						{/if}
						Continue
					</button>
				</form>
			{:else if exchanging}
				<div class="protect-verifying">
					<Loader2 class="h-5 w-5 animate-spin" />
					<span>Verifying access…</span>
				</div>
			{:else if error}
				<p class="protect-error">{error}</p>
				{#if !$isSignedIn}
					<button class="btn btn-primary protect-submit" onclick={signIn}>
						<LogIn size={16} />
						Sign in with Orchard
					</button>
				{/if}
			{:else if !$isSignedIn}
				<p class="protect-hint">Sign in to your Orchard account to continue.</p>
				<button class="btn btn-primary protect-submit" onclick={signIn}>
					<LogIn size={16} />
					Sign in with Orchard
				</button>
			{:else}
				<button class="btn btn-primary protect-submit" onclick={attemptExchange}>
					<LogIn size={16} />
					Continue as {$user?.email}
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.protect-page {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
		background: var(--center-channel-bg);
		position: relative;
		overflow: hidden;
	}

	.protect-bg {
		position: absolute;
		inset: 0;
		pointer-events: none;
		overflow: hidden;
	}

	.protect-grid {
		position: absolute;
		inset: 0;
		background-image:
			linear-gradient(var(--surface-border) 1px, transparent 1px),
			linear-gradient(90deg, var(--surface-border) 1px, transparent 1px);
		background-size: 60px 60px;
		opacity: 0.4;
		mask-image: radial-gradient(ellipse 80% 60% at 50% 50%, black 20%, transparent 100%);
		-webkit-mask-image: radial-gradient(ellipse 80% 60% at 50% 50%, black 20%, transparent 100%);
	}

	.protect-orb {
		position: absolute;
		border-radius: 50%;
		filter: blur(80px);
		opacity: 0.5;
		will-change: transform;
	}

	.protect-orb-1 {
		width: 500px;
		height: 500px;
		background: var(--button-bg);
		top: -15%;
		right: -10%;
		animation: protect-float-1 18s ease-in-out infinite;
	}

	.protect-orb-2 {
		width: 400px;
		height: 400px;
		background: color-mix(in srgb, var(--button-bg) 60%, #ff8c37);
		bottom: -15%;
		left: -10%;
		animation: protect-float-2 22s ease-in-out infinite;
	}

	.protect-orb-3 {
		width: 250px;
		height: 250px;
		background: color-mix(in srgb, var(--button-bg) 40%, #33d6a6);
		top: 40%;
		left: 30%;
		animation: protect-float-3 15s ease-in-out infinite;
	}

	@keyframes protect-float-1 {
		0%,
		100% {
			transform: translate(0, 0) scale(1);
		}
		33% {
			transform: translate(60px, 40px) scale(1.1);
		}
		66% {
			transform: translate(-30px, 70px) scale(0.95);
		}
	}

	@keyframes protect-float-2 {
		0%,
		100% {
			transform: translate(0, 0) scale(1);
		}
		33% {
			transform: translate(-50px, -60px) scale(1.05);
		}
		66% {
			transform: translate(40px, -30px) scale(0.9);
		}
	}

	@keyframes protect-float-3 {
		0%,
		100% {
			transform: translate(0, 0) scale(1);
		}
		50% {
			transform: translate(80px, -50px) scale(1.15);
		}
	}

	.protect-card {
		position: relative;
		background: color-mix(in srgb, var(--surface-bg) 90%, transparent);
		border: 1px solid var(--surface-border);
		border-radius: 1.5rem;
		padding: 2.5rem;
		max-width: 24rem;
		width: 100%;
		text-align: center;
		backdrop-filter: blur(24px);
		-webkit-backdrop-filter: blur(24px);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.04),
			0 25px 50px -12px rgb(0 0 0 / 0.12),
			0 0 0 1px rgb(255 255 255 / 0.05) inset;
	}

	.protect-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 3rem;
		height: 3rem;
		border-radius: 0.75rem;
		background: color-mix(in srgb, var(--button-bg) 15%, transparent);
		color: var(--button-bg);
		margin-bottom: 1.25rem;
	}

	.protect-icon--error {
		background: color-mix(in srgb, var(--error-text-color) 15%, transparent);
		color: var(--error-text-color);
	}

	.protect-title {
		font-size: 1.375rem;
		font-weight: 700;
		letter-spacing: -0.025em;
		color: var(--center-channel-color);
		margin: 0 0 0.5rem;
		line-height: 1.2;
	}

	.protect-subtitle {
		font-size: 0.875rem;
		color: var(--surface-muted);
		margin: 0 0 1.5rem;
		line-height: 1.5;
	}

	.protect-host {
		color: var(--center-channel-color);
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		font-weight: 600;
	}

	.protect-hint {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		margin: 0 0 1rem;
	}

	.protect-form {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.protect-input {
		text-align: center;
	}

	.protect-submit {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
	}

	.protect-error {
		font-size: 0.8125rem;
		color: var(--error-text-color);
		margin: 0;
	}

	.protect-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem 0;
		color: var(--surface-muted);
	}

	.protect-verifying {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.5rem 0;
		color: var(--surface-muted);
		font-size: 0.875rem;
	}
</style>
