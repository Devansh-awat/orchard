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
	</div>

	{#if loading}
		<div class="protect-card">
			<div class="protect-loading">
				<Loader2 class="h-6 w-6 animate-spin" />
			</div>
		</div>
	{:else if error && !info}
		<div class="protect-card">
			<div class="protect-card-icon protect-card-icon-error">
				<Shield size={24} />
			</div>
			<h2 class="protect-title">{error}</h2>
		</div>
	{:else if info}
		<div class="protect-card">
			<div class="protect-card-icon">
				<Shield size={24} />
			</div>
			<h2 class="protect-title">Protected deployment</h2>
			<p class="protect-subtitle">
				<strong>{info.host}</strong> requires authentication.
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
						class="protect-input"
						placeholder="Enter password"
						bind:value={password}
						disabled={exchanging}
						autocomplete="current-password"
					/>
					{#if passwordError}
						<p class="protect-error">{passwordError}</p>
					{/if}
					<button
						class="protect-btn protect-btn-primary"
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
				<div class="protect-loading-inline">
					<Loader2 class="h-5 w-5 animate-spin" />
					<span>Verifying access…</span>
				</div>
			{:else if error}
				<p class="protect-error">{error}</p>
				{#if !$isSignedIn}
					<button class="protect-btn protect-btn-primary" onclick={signIn}>
						<LogIn size={16} />
						Sign in with Orchard
					</button>
				{/if}
			{:else if !$isSignedIn}
				<p class="protect-hint">Sign in to your Orchard account to continue.</p>
				<button class="protect-btn protect-btn-primary" onclick={signIn}>
					<LogIn size={16} />
					Sign in with Orchard
				</button>
			{:else}
				<button class="protect-btn protect-btn-primary" onclick={attemptExchange}>
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
		background: #0a0a0f;
		position: relative;
		overflow: hidden;
	}

	.protect-bg {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.protect-orb {
		position: absolute;
		border-radius: 50%;
		filter: blur(120px);
		opacity: 0.15;
	}

	.protect-orb-1 {
		width: 600px;
		height: 600px;
		background: #6366f1;
		top: -200px;
		right: -100px;
	}

	.protect-orb-2 {
		width: 400px;
		height: 400px;
		background: #8b5cf6;
		bottom: -150px;
		left: -100px;
	}

	.protect-card {
		position: relative;
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 1rem;
		padding: 2.5rem;
		max-width: 400px;
		width: 100%;
		text-align: center;
		backdrop-filter: blur(24px);
	}

	.protect-card-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 48px;
		height: 48px;
		border-radius: 12px;
		background: rgba(99, 102, 241, 0.15);
		color: #818cf8;
		margin-bottom: 1.25rem;
	}

	.protect-card-icon-error {
		background: rgba(239, 68, 68, 0.15);
		color: #f87171;
	}

	.protect-title {
		font-size: 1.25rem;
		font-weight: 600;
		color: #f1f5f9;
		margin: 0 0 0.5rem;
	}

	.protect-subtitle {
		font-size: 0.875rem;
		color: #94a3b8;
		margin: 0 0 1.5rem;
		line-height: 1.5;
	}

	.protect-subtitle strong {
		color: #cbd5e1;
		font-family: monospace;
		font-size: 0.8125rem;
	}

	.protect-hint {
		font-size: 0.8125rem;
		color: #94a3b8;
		margin: 0 0 1rem;
	}

	.protect-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.protect-input {
		width: 100%;
		padding: 0.625rem 0.875rem;
		border-radius: 0.5rem;
		border: 1px solid rgba(255, 255, 255, 0.1);
		background: rgba(255, 255, 255, 0.05);
		color: #f1f5f9;
		font-size: 0.875rem;
		outline: none;
		transition: border-color 0.15s;
	}

	.protect-input:focus {
		border-color: #6366f1;
	}

	.protect-input::placeholder {
		color: #64748b;
	}

	.protect-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.625rem 1.25rem;
		border-radius: 0.5rem;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: opacity 0.15s;
		border: none;
	}

	.protect-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.protect-btn-primary {
		background: #6366f1;
		color: white;
	}

	.protect-btn-primary:hover:not(:disabled) {
		opacity: 0.9;
	}

	.protect-error {
		font-size: 0.8125rem;
		color: #f87171;
		margin: 0;
	}

	.protect-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem 0;
		color: #94a3b8;
	}

	.protect-loading-inline {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.5rem 0;
		color: #94a3b8;
		font-size: 0.875rem;
	}
</style>
