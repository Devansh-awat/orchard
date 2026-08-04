<script lang="ts">
	import './home-page.css';
	import AsciiVine from '$lib/components/AsciiVine.svelte';
	import { Button, Input } from '$lib/components/ui';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { env } from '$env/dynamic/public';
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

	const vineTone =
		browser && document.documentElement.classList.contains('dark') ? 'dark' : 'light';

	const oauthProvider = env.PUBLIC_OAUTH_PROVIDER || 'hackclub';
	const oauthLabel =
		env.PUBLIC_OAUTH_PROVIDER_LABEL || (oauthProvider === 'hackclub' ? 'Hack Club' : 'SSO');

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
			passkeySupported =
				window.isSecureContext && typeof window.PublicKeyCredential !== 'undefined';
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

	let authMode = $state<'start' | 'passkey' | 'code'>('start');
	let authChecking = $state(false);

	async function continueWithEmail() {
		if (authChecking || otpRequesting) return;

		const email = otpEmail.trim().toLowerCase();
		if (!email) {
			otpError = 'Enter the email address you use with Orchard.';
			return;
		}

		authChecking = true;
		otpError = null;
		passkeyError = null;

		try {
			let hasPasskeys = false;
			if (passkeySupported) {
				try {
					const response = await apiFetch(
						`/apiv1/auth/passkey/check?email=${encodeURIComponent(email)}`
					);
					const data = await response.json().catch(() => ({}));
					hasPasskeys = Boolean(data?.hasPasskeys);
				} catch {
					hasPasskeys = false;
				}
			}

			if (hasPasskeys) {
				passkeyEmail = email;
				authMode = 'passkey';
				await signInWithPasskey();
			} else {
				await requestOtp();
				if (otpStep === 'code') authMode = 'code';
			}
		} finally {
			authChecking = false;
		}
	}

	async function useCodeInstead() {
		passkeyError = null;
		await requestOtp();
		if (otpStep === 'code') authMode = 'code';
	}

	function resetAuth() {
		authMode = 'start';
		otpStep = 'email';
		otpCode = '';
		otpMessage = null;
		otpError = null;
		passkeyError = null;
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
	<div class="lg2-page">
		<div class="lg-vine" aria-hidden="true">
			<AsciiVine class="lg-vine-canvas" tone={vineTone} seed={23} band={[0.25, 0.7]} />
		</div>
		<div class="lg2-grid">
			<div class="lg2-hero">
				<img src="/logo/logocolor.svg" alt="Orchard" class="lg2-logo logo-light" />
				<img src="/logo/logocolordm.svg" alt="Orchard" class="lg2-logo logo-dark" />
				<h1 class="lg2-headline">Welcome <em>back</em>.</h1>
			</div>
			<div class="lg2-card">
				{#if privateBetaBlocked}
					<div class="lg-beta">
						<h2 class="lg-beta-title">
							{signupsDisabled ? 'Signups disabled' : 'Private beta'}
						</h2>
						<p class="lg-beta-desc">
							{signupsDisabled
								? 'Signups are disabled on this Orchard instance. Contact your administrator for access.'
								: 'Orchard is currently in private beta. You need an invitation from an existing organization to access the platform.'}
						</p>
						<Button
							variant="primary"
							class="lg-wide"
							onclick={() => {
								privateBetaBlocked = false;
							}}
						>
							Back to sign in
						</Button>
					</div>
				{:else}
					{#if oauthProvider !== 'none'}
						<Button variant="primary" class="lg-wide" onclick={() => user.signIn()}>
							Continue with {oauthLabel}
						</Button>
						<div class="lg-divider"><span>or</span></div>
					{/if}
					{#if authMode === 'start'}
						<form
							class="lg-form"
							novalidate
							onsubmit={(e) => {
								e.preventDefault();
								continueWithEmail();
							}}
						>
							<label class="lg-label" for="otp-email">Email address</label>
							<Input
								type="email"
								name="email"
								placeholder="you@example.com"
								id="otp-email"
								bind:value={otpEmail}
								autocomplete="email webauthn"
								required
								class="lg-wide"
							/>
							{#if otpError}
								<p class="lg-error">{otpError}</p>
							{/if}
							<Button
								variant="secondary"
								type="submit"
								loading={authChecking || otpRequesting}
								class="lg-wide lg-action"
							>
								Continue
							</Button>
						</form>
					{:else if authMode === 'passkey'}
						<div class="lg-step">
							<div class="lg-step-head">
								<p class="lg-step-title">{otpEmail}</p>
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
							{#if passkeyError}
								<p class="lg-error">{passkeyError}</p>
							{/if}
							<Button
								variant="ghost"
								class="lg-wide"
								loading={otpRequesting}
								onclick={useCodeInstead}
							>
								Email me a code instead
							</Button>
							{#if otpError}
								<p class="lg-error">{otpError}</p>
							{/if}
							<Button variant="ghost" size="sm" class="lg-center" onclick={resetAuth}>Back</Button>
						</div>
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
								<p class="lg-step-title">{otpEmail}</p>
								{#if otpMessage}
									<p class="lg-step-hint">{otpMessage}</p>
								{/if}
							</div>
							<label class="lg-label" for="otp-code">Verification code</label>
							<Input
								type="text"
								name="code"
								inputmode="numeric"
								maxlength="6"
								placeholder="000000"
								id="otp-code"
								bind:value={otpCode}
								autocomplete="one-time-code"
								class="lg-wide lg-code"
							/>
							{#if otpError}
								<p class="lg-error">{otpError}</p>
							{/if}
							<Button
								variant="secondary"
								type="submit"
								loading={otpVerifying}
								class="lg-wide lg-action"
							>
								Verify
							</Button>
							<Button variant="ghost" size="sm" class="lg-center" onclick={resetAuth}>Back</Button>
						</form>
					{/if}
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
						<div
							class="skeleton"
							style="width: 2rem; height: 2rem; border-radius: var(--radius-sm);"
						></div>
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
