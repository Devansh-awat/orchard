<script lang="ts">
	import './home-page.css';
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
		KeyRound,
		Rocket,
		Database,
		Globe,
		ArrowRight,
		Search,
		Sparkles
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

	let deploymentCount = $state(0);
	let databaseCount = $state(0);
	let ingressCount = $state(0);

	let greeting = $derived.by(() => {
		const hour = new Date().getHours();
		if (hour < 12) return 'Good morning';
		if (hour < 18) return 'Good afternoon';
		return 'Good evening';
	});

	let userName = $derived.by(() => {
		const u = $user;
		if (!u) return '';
		return u.firstName || u.name || u.username || u.email?.split('@')[0] || '';
	});
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
	let signupsDisabled = $state(false);

	async function fetchWorkspaces() {
		loading = true;
		error = null;

		try {
			const [wsRes, depRes, dbRes, ingRes] = await Promise.all([
				apiFetch('/apiv1/projects'),
				apiFetch('/apiv1/deployments').catch(() => null),
				apiFetch('/apiv1/databases').catch(() => null),
				apiFetch('/apiv1/ingresses').catch(() => null)
			]);

			if (!wsRes.ok) {
				throw new Error('Failed to fetch workspaces');
			}
			workspaces = await wsRes.json();

			if (depRes?.ok) {
				const deps = await depRes.json();
				deploymentCount = Array.isArray(deps) ? deps.length : 0;
			}
			if (dbRes?.ok) {
				const dbs = await dbRes.json();
				databaseCount = Array.isArray(dbs) ? dbs.length : 0;
			}
			if (ingRes?.ok) {
				const ings = await ingRes.json();
				ingressCount = Array.isArray(ings) ? ings.length : 0;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to fetch workspaces';
		} finally {
			loading = false;
		}
	}

	// Filter workspaces by selected organization
	let organizationWorkspaces = $derived.by(() => {
		if (!$selectedOrganization) return workspaces;
		return workspaces.filter((w) => w.organizationId === $selectedOrganization.id);
	});

	let searchQuery = $state('');

	let filteredWorkspaces = $derived.by(() => {
		const query = searchQuery.trim().toLowerCase();
		if (!query) return organizationWorkspaces;
		return organizationWorkspaces.filter((workspace) => {
			const name = workspace.name.toLowerCase();
			const slug = workspace.slug.toLowerCase();
			const description = workspace.description?.toLowerCase() ?? '';
			return name.includes(query) || slug.includes(query) || description.includes(query);
		});
	});

	function openWorkspace(slug: string) {
		return goto(`/workspaces/${slug}`);
	}

	function handleWorkspaceClick(event: MouseEvent, slug: string) {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
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
			if ($user?.setupCompleted === false) {
				goto('/setup', { replaceState: true });
				return;
			}
			const slug = organizations.getDefaultSlug();
			if (slug) {
				goto(`/${slug}`, { replaceState: true });
				return;
			}
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
			const currentUser = get(user);

			// New user — redirect to setup
			if (currentUser?.setupCompleted === false) {
				goto('/setup', { replaceState: true });
				return;
			}

			// Existing user — check for pending invitations
			const pending = await pendingInvitations.fetchPending();
			if (pending.length > 0) {
				showPendingInvitationsModal.show();
			}

			const slug = organizations.getDefaultSlug();
			if (slug) {
				toasts.add({ title: message, color: 'success' });
				goto(`/${slug}`, { replaceState: true });
				return;
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
				if (
					response.status === 403 &&
					(data?.message === 'private_beta' || data?.message === 'signups_disabled')
				) {
					signupsDisabled = data.message === 'signups_disabled';
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
				if (
					verifyResponse.status === 403 &&
					(data?.message === 'private_beta' || data?.message === 'signups_disabled')
				) {
					signupsDisabled = data.message === 'signups_disabled';
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

{#if !$isSignedIn}
	<div class="login-page">
		<!-- Animated background -->
		<div class="login-bg">
			<div class="login-orb login-orb-1"></div>
			<div class="login-orb login-orb-2"></div>
			<div class="login-orb login-orb-3"></div>
			<div class="login-orb login-orb-4"></div>
			<div class="login-grid-overlay"></div>
		</div>

		<div class="login-container">
			<!-- Left branding side -->
			<div class="login-hero">
				<div class="login-hero-content">
					<img src="/logo/logofulldm.svg" alt="Orchard" class="login-hero-logo" />
					<p class="login-hero-subtitle">Deploy, manage, and scale your applications with ease.</p>
					<div class="login-hero-features">
						<div class="login-hero-feature">
							<div class="login-hero-feature-icon">
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="20"
									height="20"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path
										d="M2 12l10 5 10-5"
									/></svg
								>
							</div>
							<span>One-click deployments</span>
						</div>
						<div class="login-hero-feature">
							<div class="login-hero-feature-icon">
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="20"
									height="20"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path
										d="M9 21V9"
									/></svg
								>
							</div>
							<span>Workspace collaboration</span>
						</div>
						<div class="login-hero-feature">
							<div class="login-hero-feature-icon">
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="20"
									height="20"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" /></svg
								>
							</div>
							<span>Built-in security</span>
						</div>
					</div>
				</div>
			</div>

			<!-- Right form side -->
			<div class="login-form-side">
				{#if privateBetaBlocked}
					<div class="login-panel" style="text-align: center;">
						<div class="login-panel-header">
							<h2 class="login-panel-title">Orchard</h2>
						</div>
						<div
							style="margin-bottom: 1.25rem; display: flex; align-items: center; justify-content: center;"
						>
							<div class="login-lock-icon">
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="24"
									height="24"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path
										d="M7 11V7a5 5 0 0 1 10 0v4"
									/></svg
								>
							</div>
						</div>
						<h3 class="login-beta-title">
							{signupsDisabled ? 'Signups Disabled' : 'Private Beta'}
						</h3>
						<p class="login-beta-desc">
							{signupsDisabled
								? 'Signups are disabled on this Orchard instance. Contact your administrator for access.'
								: 'Orchard is currently in private beta. You need an invitation from an existing organization to access the platform.'}
						</p>
						<button
							class="btn btn-primary login-submit"
							onclick={() => {
								privateBetaBlocked = false;
							}}
						>
							Back to Sign In
						</button>
					</div>
				{:else}
					<div class="login-panel">
						<div class="login-panel-header">
							<h2 class="login-panel-title">Sign in to Orchard</h2>
						</div>

						<button class="login-primary" onclick={() => user.signIn()}>
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
								{otpStep === 'email' ? 'Send code' : 'Verify'}
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
						{:else if passkeySupportReason}
							<p class="login-muted">{passkeySupportReason}</p>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</div>
{:else}
	<!-- Dashboard for authenticated users -->
	<div class="hp">
		<div class="hp-grid-bg"></div>
		<div class="hp-topbar">
			<div>
				<h1 class="hp-greeting">{greeting}{userName ? `, ${userName}` : ''}</h1>
			</div>
			<a href="/workspaces/new" class="hp-new-btn">
				<Plus size={15} />
				New Workspace
			</a>
		</div>

		{#if error}
			<div class="hp-error">{error}</div>
		{/if}

		{#if loading}
			<div class="hp-stats">
				{#each Array(4) as _, i (i)}
					<div class="hp-stat">
						<div class="skeleton" style="width: 2rem; height: 2rem; border-radius: 0.5rem;"></div>
						<div class="hp-stat-info">
							<div class="skeleton" style="width: 2rem; height: 1.25rem;"></div>
							<div class="skeleton" style="width: 4rem; height: 0.75rem;"></div>
						</div>
					</div>
				{/each}
			</div>
			<div class="hp-grid">
				{#each Array(4) as _, i (i)}
					<div class="hp-card hp-skeleton-card">
						<div class="hp-card-top">
							<div class="skeleton skeleton-icon"></div>
						</div>
						<div class="hp-card-body">
							<div class="skeleton skeleton-title"></div>
							<div class="skeleton skeleton-desc"></div>
						</div>
						<div class="hp-card-footer">
							<div class="skeleton skeleton-badge"></div>
							<div class="skeleton skeleton-badge"></div>
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="hp-stats">
				<div class="hp-stat">
					<div class="hp-stat-icon hp-stat-icon--workspaces">
						<FolderKanban size={18} />
					</div>
					<div class="hp-stat-info">
						<span class="hp-stat-value">{organizationWorkspaces.length}</span>
						<span class="hp-stat-label">Workspaces</span>
					</div>
				</div>
				<div class="hp-stat">
					<div class="hp-stat-icon hp-stat-icon--deployments">
						<Rocket size={18} />
					</div>
					<div class="hp-stat-info">
						<span class="hp-stat-value">{deploymentCount}</span>
						<span class="hp-stat-label">Apps</span>
					</div>
				</div>
				<div class="hp-stat">
					<div class="hp-stat-icon hp-stat-icon--databases">
						<Database size={18} />
					</div>
					<div class="hp-stat-info">
						<span class="hp-stat-value">{databaseCount}</span>
						<span class="hp-stat-label">Databases</span>
					</div>
				</div>
				<div class="hp-stat">
					<div class="hp-stat-icon hp-stat-icon--ingresses">
						<Globe size={18} />
					</div>
					<div class="hp-stat-info">
						<span class="hp-stat-value">{ingressCount}</span>
						<span class="hp-stat-label">Ingresses</span>
					</div>
				</div>
			</div>

			<div class="hp-section">
				<div class="hp-section-header">
					<h2 class="hp-section-title">Workspaces</h2>
					{#if organizationWorkspaces.length > 3}
						<div class="hp-search-wrap">
							<Search size={14} class="hp-search-icon" />
							<input
								type="search"
								placeholder="Filter..."
								class="hp-search"
								bind:value={searchQuery}
							/>
						</div>
					{/if}
				</div>

				{#if !organizationWorkspaces.length}
					<div class="hp-empty hp-empty--dashed">
						<div class="hp-empty-icon">
							<Sparkles size={24} />
						</div>
						<h3 class="hp-empty-title">Create your first workspace</h3>
						<p class="hp-empty-desc">
							Workspaces help you organize projects, deployments, and team members.
						</p>
						<a href="/workspaces/new" class="hp-new-btn">
							<Plus size={16} />
							Create Workspace
						</a>
					</div>
				{:else if filteredWorkspaces.length}
					<div class="hp-grid">
						{#each filteredWorkspaces as workspace (workspace.id)}
							<a
								href={`/workspaces/${workspace.slug}`}
								onclick={(event) => handleWorkspaceClick(event, workspace.slug)}
								class="hp-card"
							>
								<div class="hp-card-top">
									<div class="hp-card-icon">
										<FolderKanban size={18} />
									</div>
									<div class="hp-card-arrow">
										<ArrowRight size={14} />
									</div>
								</div>
								<div class="hp-card-body">
									<span class="hp-card-name">{workspace.name}</span>
									{#if workspace.description}
										<span class="hp-card-desc">{workspace.description}</span>
									{/if}
								</div>
								<div class="hp-card-footer">
									<span class="hp-card-count">
										<FolderKanban size={11} />
										{workspace._count?.projects ?? workspace.projects?.length ?? 0}
									</span>
									<span class="hp-card-count">
										<Users size={11} />
										{workspace._count?.members ?? workspace.members?.length ?? 0}
									</span>
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
{/if}
