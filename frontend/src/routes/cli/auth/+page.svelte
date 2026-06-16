<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { user, isSignedIn, apiFetch } from '$lib/stores';
	import { Loader2, Terminal } from 'lucide-svelte';

	let port = $derived($page.url.searchParams.get('port') || '');
	let state = $derived($page.url.searchParams.get('state') || '');
	let label = $derived($page.url.searchParams.get('label') || 'Orchard CLI');

	let error = $state<string | null>(null);
	let authorizing = $state(false);
	let done = $state(false);

	// The callback host is hard-coded to loopback; only the port comes from the
	// query string. This prevents a crafted link from redirecting a freshly
	// minted token to an attacker-controlled origin.
	function callbackUrl(params: Record<string, string>): string {
		const u = new URL(`http://127.0.0.1:${encodeURIComponent(port)}/callback`);
		for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
		return u.toString();
	}

	function validPort(): boolean {
		const n = Number(port);
		return Number.isInteger(n) && n > 0 && n < 65536;
	}

	async function authorize() {
		if (authorizing) return;
		authorizing = true;
		error = null;
		try {
			const res = await apiFetch('/apiv1/auth/tokens', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: label, scopes: ['read', 'deploy', 'exec'] })
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.message || 'Failed to create token. Please sign in and try again.');
			}
			const { token } = await res.json();
			done = true;
			window.location.href = callbackUrl({ token, state });
		} catch (err) {
			error = err instanceof Error ? err.message : 'Authorization failed.';
			authorizing = false;
		}
	}

	function deny() {
		if (validPort()) window.location.href = callbackUrl({ error: 'access_denied', state });
	}

	function signIn() {
		if (browser) {
			// Reuse the callback's invite-redirect hook so we land back here,
			// with the same query params, after the Hack Club round-trip.
			sessionStorage.setItem('inviteRedirect', $page.url.pathname + $page.url.search);
			user.signIn();
		}
	}

	onMount(() => {
		if (!port || !state) {
			error = 'Invalid request: missing port or state. Re-run `orchard auth login`.';
			return;
		}
		if (!validPort()) {
			error = 'Invalid callback port.';
		}
	});
</script>

<svelte:head>
	<title>Authorize CLI — Orchard</title>
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
					The <strong>Orchard CLI</strong> on this computer is requesting access to your account.
				</p>
				<div class="cli-details">
					<p class="cli-label">A personal API token will be created and sent to:</p>
					<p class="cli-host"><Terminal class="h-4 w-4" /> 127.0.0.1:{port}</p>
					<p class="cli-name">{label}</p>
					<p class="cli-warning">
						Only approve if you just ran <code>orchard auth login</code> on this machine.
					</p>
				</div>
			</div>
		</div>

		<div class="login-form-side">
			{#if error}
				<div class="login-panel" style="text-align:center;">
					<div class="login-panel-header">
						<h2 class="login-panel-title">Authorization Failed</h2>
					</div>
					<p class="login-error">{error}</p>
				</div>
			{:else if done}
				<div class="login-panel" style="text-align:center;">
					<div class="login-panel-header"><h2 class="login-panel-title">Authorized</h2></div>
					<p class="login-success">Token sent to your terminal. You can close this tab.</p>
				</div>
			{:else if $isSignedIn}
				<div class="login-panel">
					<div class="login-panel-header">
						<h2 class="login-panel-title">Authorize CLI access</h2>
						<p class="login-panel-desc">Signed in as <strong>{$user?.email}</strong></p>
					</div>
					<button class="login-primary" onclick={authorize} disabled={authorizing}>
						{#if authorizing}<Loader2 class="h-4 w-4 animate-spin" />{/if}
						{authorizing ? 'Authorizing…' : 'Authorize'}
					</button>
					<button class="login-back" style="margin-top:.75rem" onclick={deny}>Cancel</button>
				</div>
			{:else}
				<div class="login-panel">
					<div class="login-panel-header">
						<h2 class="login-panel-title">Sign in to authorize</h2>
					</div>
					<button class="login-primary" onclick={signIn}>
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
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.cli-details {
		margin-top: 1.5rem;
		padding: 1rem;
		border-radius: 0.5rem;
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid rgba(255, 255, 255, 0.1);
		text-align: left;
	}
	.cli-label {
		font-size: 0.875rem;
		opacity: 0.75;
		margin: 0 0 0.5rem 0;
	}
	.cli-host {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 1.125rem;
		font-weight: 600;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		margin: 0 0 0.25rem 0;
	}
	.cli-name {
		font-size: 0.8125rem;
		opacity: 0.6;
		margin: 0 0 0.75rem 0;
	}
	.cli-warning {
		font-size: 0.8125rem;
		opacity: 0.8;
		margin: 0;
		padding-top: 0.75rem;
		border-top: 1px solid rgba(255, 255, 255, 0.08);
	}
	.cli-warning code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: rgba(255, 255, 255, 0.08);
		padding: 0.1rem 0.3rem;
		border-radius: 0.25rem;
	}
</style>
