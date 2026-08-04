<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { Loader2, Lock, ShieldX } from 'lucide-svelte';
	import { Button, Input } from '$lib/components/ui';
	import { motionStagger } from '$lib/utils/motion.svelte';
	import { apiFetch, initApiBase, user, isSignedIn } from '$lib/stores';
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
	<title>Protected deployment — Orchard</title>
</svelte:head>

<div class="protect-page">
	{#if loading}
		<div class="protect-loading">
			<Loader2 class="h-5 w-5 animate-spin" />
		</div>
	{:else if error && !info}
		<div class="protect-stack">
			<div class="protect-icon protect-icon--error" {@attach motionStagger({ index: 0 })}>
				<ShieldX size={22} />
			</div>
			<h1 class="protect-title" {@attach motionStagger({ index: 1 })}>{error}</h1>
		</div>
	{:else if info}
		<div class="protect-stack">
			<div class="protect-icon" {@attach motionStagger({ index: 0 })}>
				<Lock size={22} />
			</div>
			<h1 class="protect-title" {@attach motionStagger({ index: 1 })}>
				This deployment is protected
			</h1>
			<p class="protect-subtitle" {@attach motionStagger({ index: 2 })}>
				{#if mode === 'password'}
					Enter the password to view <span class="protect-host">{info.host}</span>
				{:else}
					Sign in with an Orchard account that has access to
					<span class="protect-host">{info.host}</span>
				{/if}
			</p>

			<div class="protect-action" {@attach motionStagger({ index: 3 })}>
				{#if mode === 'password'}
					<form
						class="protect-form"
						onsubmit={(e) => {
							e.preventDefault();
							submitPassword();
						}}
					>
						<Input
							type="password"
							class="protect-input"
							placeholder="Password"
							bind:value={password}
							error={!!passwordError}
							disabled={exchanging}
							autocomplete="current-password"
						/>
						{#if passwordError}
							<p class="protect-error">{passwordError}</p>
						{/if}
						<Button
							variant="primary"
							class="w-full"
							type="submit"
							loading={exchanging}
							disabled={!password.trim()}
						>
							Continue
						</Button>
					</form>
				{:else if exchanging}
					<div class="protect-verifying">
						<Loader2 class="h-4 w-4 animate-spin" />
						<span>Verifying access…</span>
					</div>
				{:else if error}
					<p class="protect-error">{error}</p>
					{#if !$isSignedIn}
						<Button variant="primary" class="w-full" onclick={signIn}>Continue with Orchard</Button>
					{/if}
				{:else if !$isSignedIn}
					<Button variant="primary" class="w-full" onclick={signIn}>Continue with Orchard</Button>
				{:else}
					<Button variant="primary" class="w-full" onclick={attemptExchange}>
						Continue as {$user?.email}
					</Button>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.protect-page {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		background: var(--center-channel-bg);
	}

	.protect-stack {
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 100%;
		max-width: 20rem;
		text-align: center;
	}

	.protect-loading {
		color: var(--surface-muted);
	}

	.protect-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 3rem;
		height: 3rem;
		border-radius: var(--radius-lg);
		background: var(--surface-bg);
		border: 1px solid var(--surface-border);
		color: var(--center-channel-color);
		margin-bottom: 1.25rem;
	}

	.protect-icon--error {
		background: color-mix(in srgb, var(--error-text-color) 8%, transparent);
		border-color: color-mix(in srgb, var(--error-text-color) 25%, transparent);
		color: var(--error-text-color);
	}

	.protect-title {
		font-size: var(--text-title-3);
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--center-channel-color);
		margin: 0 0 0.5rem;
		line-height: 1.3;
	}

	.protect-subtitle {
		font-size: var(--text-callout);
		color: var(--surface-muted);
		margin: 0 0 1.5rem;
		line-height: 1.6;
	}

	.protect-host {
		color: var(--center-channel-color);
		font-family: var(--font-mono);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		white-space: nowrap;
	}

	.protect-action {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.protect-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.protect-form :global(.protect-input) {
		text-align: center;
	}

	.protect-error {
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		color: var(--error-text-color);
		margin: 0;
	}

	.protect-verifying {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		color: var(--surface-muted);
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
	}
</style>
