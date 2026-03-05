<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import {
		user,
		isSignedIn,
		apiFetch,
		selectedOrganization,
		organizations,
		toasts,
		pendingInvitations,
		showPendingInvitationsModal
	} from '$lib/stores';
	import type { User } from '$lib/stores';
	import {
		Loader2,
		Plus,
		Users,
		FolderKanban,
		KeyRound
	} from 'lucide-svelte';

interface Workspace {
	id: string;
	name: string;
	slug: string;
	description?: string;
	organizationId: string;
	members?: unknown[];
	projects?: unknown[];
	_count?: {
		members: number;
		projects: number;
	};
	createdAt: string;
}

	let workspaces = $state<Workspace[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
let passkeySupported = $state(false);
let passkeySupportReason = $state<string | null>(null);

	type OtpStep = 'email' | 'code';
	let otpEmail = $state('');
	let otpCode = $state('');
	let otpStep = $state<OtpStep>('email');
	let otpRequesting = $state(false);
	let otpVerifying = $state(false);
	let otpMessage = $state<string | null>(null);
	let otpError = $state<string | null>(null);

	let passkeyEmail = $state('');
	let passkeyLoading = $state(false);
	let passkeyError = $state<string | null>(null);

	let privateBetaBlocked = $state(false);

	async function fetchWorkspaces() {
		loading = true;
		error = null;

		try {
			const response = await apiFetch('/apiv1/workspaces');
			if (!response.ok) {
				throw new Error('Failed to fetch workspaces');
			}
			workspaces = await response.json();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to fetch workspaces';
		} finally {
			loading = false;
		}
	}

	// Filter workspaces by selected organization
	let organizationWorkspaces = $derived.by(() => {
		if (!$selectedOrganization) return workspaces;
		return workspaces.filter(w => w.organizationId === $selectedOrganization.id);
	});

	let searchQuery = $state('');

	let filteredWorkspaces = $derived.by(() => {
		const query = searchQuery.trim().toLowerCase();
		if (!query) return organizationWorkspaces;
		return organizationWorkspaces.filter(workspace => {
			const name = workspace.name.toLowerCase();
			const slug = workspace.slug.toLowerCase();
			const description = workspace.description?.toLowerCase() ?? '';
			return (
				name.includes(query) ||
				slug.includes(query) ||
				description.includes(query)
			);
		});
	});

	function openWorkspace(slug: string) {
		return goto(`/workspaces/${slug}`);
	}

	function handleWorkspaceClick(event: MouseEvent, slug: string) {
		if (
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey ||
			event.button !== 0
		) {
			return;
		}

		event.preventDefault();
		openWorkspace(slug);
	}

	onMount(() => {
		if (browser && typeof window !== 'undefined') {
			if (!window.isSecureContext) {
				passkeySupported = false;
				passkeySupportReason = `Passkeys require a secure origin (https:// or http://localhost). You're on ${window.location.origin}.`;
			} else if (typeof window.PublicKeyCredential !== 'undefined') {
				passkeySupported = true;
				passkeySupportReason = null;
			} else {
				passkeySupported = false;
				passkeySupportReason = 'This browser does not expose WebAuthn support.';
			}
		}

		if ($isSignedIn) {
			fetchWorkspaces();
		} else {
			loading = false;
		}
	});

	async function refreshUserContext(skipUserFetch = false) {
		if (!skipUserFetch) {
			await user.fetchUser();
		}

		if (get(isSignedIn)) {
			try {
				const response = await apiFetch('/apiv1/organizations/user');
				if (response.ok) {
					const orgs = await response.json();
					organizations.set(orgs);
					organizations.initializeSelected();
				}
			} catch (err) {
				console.error('Failed to refresh organizations after sign-in', err);
			}
		}
	}

	async function handlePostAuth(message: string, signedInUser?: User) {
		if (signedInUser) {
			user.set(signedInUser);
		}

		await refreshUserContext(Boolean(signedInUser));

		if (get(isSignedIn)) {
			await fetchWorkspaces();

			// Check for pending invitations after login
			const pending = await pendingInvitations.fetchPending();
			if (pending.length > 0) {
				showPendingInvitationsModal.show();
			}
		}

		toasts.add({
			title: message,
			color: 'success'
		});
	}

	async function requestOtp() {
		if (otpRequesting) return;

		const email = otpEmail.trim().toLowerCase();
		if (!email) {
			otpError = 'Enter the email address you use with Orchard.';
			return;
		}

		otpRequesting = true;
		otpError = null;

		try {
			const response = await apiFetch('/apiv1/auth/otp/request', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
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

		if (!email) {
			otpError = 'Please enter your email.';
			return;
		}

		if (!code || code.length !== 6) {
			otpError = 'Enter the 6-digit code we sent you.';
			return;
		}

		otpVerifying = true;
		otpError = null;

		try {
			const response = await apiFetch('/apiv1/auth/otp/verify', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ email, code })
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				if (response.status === 403 && data?.message === 'private_beta') {
					privateBetaBlocked = true;
					return;
				}
				throw new Error(data?.message || 'Invalid OTP code.');
			}

			const data = await response.json().catch(() => null);
			await handlePostAuth('Signed in with your email', data?.user);
		} catch (err) {
			otpError = err instanceof Error ? err.message : 'Failed to verify code.';
		} finally {
			otpVerifying = false;
		}
	}

	async function signInWithPasskey() {
		if (passkeyLoading) return;

		if (!browser || typeof window === 'undefined') {
			passkeyError = 'Passkeys are not supported in this environment.';
			return;
		}

		if (!window.isSecureContext) {
			passkeyError = 'Passkeys require https:// or http://localhost.';
			return;
		}

		if (!window.PublicKeyCredential) {
			passkeyError = 'Passkeys are not supported on this device.';
			return;
		}

		passkeyLoading = true;
		passkeyError = null;

		try {
		const response = await apiFetch('/apiv1/auth/passkey/authenticate/options', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					email: passkeyEmail.trim() || undefined
				})
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || 'Could not start passkey authentication.');
			}

		const options = await response.json();

		const { startAuthentication } = await import('@simplewebauthn/browser');
		const credential = await startAuthentication({
			optionsJSON: options
		});

			const verifyResponse = await apiFetch('/apiv1/auth/passkey/authenticate/verify', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					response: credential
				})
			});

			if (!verifyResponse.ok) {
				const data = await verifyResponse.json().catch(() => ({}));
				if (verifyResponse.status === 403 && data?.message === 'private_beta') {
					privateBetaBlocked = true;
					return;
				}
				throw new Error(data?.message || 'Passkey authentication failed.');
			}

			const data = await verifyResponse.json().catch(() => null);
			await handlePostAuth('Signed in with your passkey', data?.user);
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
</script>

<div class="p-6">
	{#if !$isSignedIn}
		<div class="login-page">
			{#if privateBetaBlocked}
				<div class="login-panel" style="text-align: center;">
					<h1 class="login-title">Orchard</h1>
					<div style="margin-bottom: 1.25rem; display: flex; align-items: center; justify-content: center;">
						<div style="width: 3rem; height: 3rem; border-radius: 9999px; background-color: var(--control-bg); display: flex; align-items: center; justify-content: center;">
							<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--surface-muted);"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
						</div>
					</div>
					<h2 style="font-size: 1.125rem; font-weight: 600; color: var(--center-channel-color); margin-bottom: 0.5rem;">Private Beta</h2>
					<p style="font-size: 0.875rem; color: var(--surface-muted); margin-bottom: 1.5rem;">Orchard is currently in private beta. You need an invitation from an existing organization to access the platform.</p>
					<button class="btn btn-primary" style="width: 100%;" onclick={() => { privateBetaBlocked = false; }}>
						Back to Sign In
					</button>
				</div>
			{:else}
			<div class="login-panel">
				<h1 class="login-title">Orchard</h1>
				<button class="login-primary" onclick={() => user.signIn()}>
					Continue with Hack Club
				</button>
				<div class="login-divider">
					<span>or</span>
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
					<input
						class="input login-input"
						type="email"
						placeholder="Email"
						id="otp-email"
						bind:value={otpEmail}
						autocomplete="email"
						required
					/>
					{#if otpStep === 'code'}
						<div class="login-otp-row">
							<input
								class="input login-input login-code"
								type="text"
								inputmode="numeric"
								maxlength="6"
								placeholder="Code"
								id="otp-code"
								bind:value={otpCode}
								autocomplete="one-time-code"
							/>
							<button type="button" class="login-back" onclick={() => { otpStep = 'email'; otpCode = ''; otpMessage = null; }}>
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
					<button class="btn btn-primary login-submit" type="submit" disabled={otpRequesting || otpVerifying}>
						{#if otpRequesting || otpVerifying}
							<Loader2 class="h-4 w-4 animate-spin" />
						{/if}
						{otpStep === 'email' ? 'Send code' : 'Verify'}
					</button>
				</form>
				{#if passkeySupported}
					<div class="login-passkey">
						<input
							class="input login-input"
							type="email"
							placeholder="Email (optional)"
							id="passkey-email"
							bind:value={passkeyEmail}
						/>
						<button class="btn btn-secondary login-passkey-btn" type="button" onclick={signInWithPasskey} disabled={passkeyLoading}>
							{#if passkeyLoading}
								<Loader2 class="h-4 w-4 animate-spin" />
							{/if}
							<KeyRound class="h-4 w-4" />
							Passkey
						</button>
						{#if passkeyError}
							<p class="login-error">{passkeyError}</p>
						{/if}
					</div>
				{:else if passkeySupportReason}
					<p class="login-muted">{passkeySupportReason}</p>
				{/if}
			</div>
			{/if}
		</div>
	{:else}
		<!-- Dashboard for authenticated users -->
		<div class="hp">
			{#if error}
				<div class="hp-error">{error}</div>
			{/if}

			<div class="hp-header">
				<h1 class="hp-title">Workspaces</h1>
				<div class="hp-actions">
					{#if organizationWorkspaces.length}
						<input
							type="search"
							placeholder="Search..."
							class="hp-search"
							bind:value={searchQuery}
						/>
					{/if}
					<a href="/workspaces/new" class="hp-new-btn">
						<Plus size={16} />
						New Workspace
					</a>
				</div>
			</div>

			{#if loading}
				<div class="hp-grid">
					{#each Array(6) as _}
						<div class="hp-card hp-skeleton-card">
							<div class="hp-card-top">
								<div class="skeleton skeleton-icon"></div>
								<div class="hp-card-counts">
									<div class="skeleton skeleton-badge"></div>
									<div class="skeleton skeleton-badge"></div>
								</div>
							</div>
							<div class="hp-card-body">
								<div class="skeleton skeleton-title"></div>
								<div class="skeleton skeleton-desc"></div>
							</div>
						</div>
					{/each}
				</div>
			{:else if !organizationWorkspaces.length}
				<div class="hp-empty hp-empty--dashed">
					<FolderKanban size={40} />
					<p>No workspaces yet</p>
					<a href="/workspaces/new" class="hp-new-btn">
						<Plus size={16} />
						Create Workspace
					</a>
				</div>
			{:else if filteredWorkspaces.length}
				<div class="hp-grid">
					{#each filteredWorkspaces as workspace}
						<a
							href={`/workspaces/${workspace.slug}`}
							onclick={(event) => handleWorkspaceClick(event, workspace.slug)}
							class="hp-card"
						>
							<div class="hp-card-top">
								<div class="hp-card-icon">
									<FolderKanban size={20} />
								</div>
								<div class="hp-card-counts">
									<span class="hp-card-count">
										<FolderKanban size={12} /> {workspace._count?.projects ?? workspace.projects?.length ?? 0}
									</span>
									<span class="hp-card-count">
										<Users size={12} /> {workspace._count?.members ?? workspace.members?.length ?? 0}
									</span>
								</div>
							</div>
							<div class="hp-card-body">
								<span class="hp-card-name">{workspace.name}</span>
								{#if workspace.description}
									<span class="hp-card-desc">{workspace.description}</span>
								{/if}
							</div>
						</a>
					{/each}
				</div>
			{:else}
				<div class="hp-empty">
					<p>No workspaces match "{searchQuery}"</p>
				</div>
			{/if}
		</div>
	{/if}
</div>
