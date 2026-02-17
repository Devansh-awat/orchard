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
	import { mergeAttrs } from 'melt';
	import { SpatialMenu } from 'melt/builders';
	import {
		Loader2,
		Plus,
		Users,
		FolderKanban,
		ArrowRight,
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

	const spatialMenu = new SpatialMenu<Workspace>({
		wrap: true,
		crossAxis: true
	});

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
		<style>
			.login-page {
				min-height: 100vh;
				display: flex;
				align-items: center;
				justify-content: center;
				padding: 1.5rem;
				background: linear-gradient(165deg, var(--surface-bg) 0%, var(--control-bg) 100%);
			}
			.login-panel {
				width: 100%;
				max-width: 22rem;
				padding: 2.5rem;
				border-radius: 1.25rem;
				border: 1px solid var(--surface-border);
				background: var(--surface-bg);
				box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.08);
			}
			.login-title {
				font-size: 1.75rem;
				font-weight: 700;
				letter-spacing: -0.02em;
				color: var(--center-channel-color);
				text-align: center;
				margin-bottom: 1.75rem;
			}
			.login-primary {
				width: 100%;
				padding: 0.75rem 1.25rem;
				font-size: 0.9375rem;
				font-weight: 600;
				color: white;
				background: var(--button-bg);
				border: none;
				border-radius: 0.75rem;
				cursor: pointer;
				transition: opacity 0.15s, transform 0.1s;
			}
			.login-primary:hover { opacity: 0.95; }
			.login-primary:active { transform: scale(0.99); }
			.login-divider {
				display: flex;
				align-items: center;
				gap: 1rem;
				margin: 1.5rem 0;
			}
			.login-divider::before,
			.login-divider::after {
				content: '';
				flex: 1;
				height: 1px;
				background: var(--surface-border);
			}
			.login-divider span {
				font-size: 0.75rem;
				font-weight: 500;
				text-transform: uppercase;
				letter-spacing: 0.05em;
				color: var(--surface-muted);
			}
			.login-form, .login-passkey {
				display: flex;
				flex-direction: column;
				gap: 0.75rem;
			}
			.login-passkey { margin-top: 1.25rem; padding-top: 1.25rem; border-top: 1px solid var(--surface-border); }
			.login-input {
				width: 100%;
				padding: 0.625rem 0.875rem;
				font-size: 0.9375rem;
				border-radius: 0.5rem;
			}
			.login-code { max-width: 6ch; }
			.login-otp-row { display: flex; align-items: center; gap: 0.5rem; }
			.login-back {
				font-size: 0.8125rem;
				font-weight: 500;
				color: var(--surface-muted);
				background: none;
				border: none;
				cursor: pointer;
				padding: 0.25rem;
			}
			.login-back:hover { color: var(--link-color); }
			.login-submit, .login-passkey-btn { width: 100%; justify-content: center; gap: 0.5rem; }
			.login-error { font-size: 0.8125rem; color: var(--error-text-color); }
			.login-success { font-size: 0.8125rem; color: #16a34a; }
			.login-muted { font-size: 0.75rem; color: var(--surface-muted); margin-top: 0.5rem; }
		</style>
	{:else}
		<!-- Dashboard for authenticated users -->
			<div class="mb-6 flex items-center justify-between">
				<div>
					<h1 class="text-2xl font-bold" style="color: var(--center-channel-color);">
						Workspaces
					</h1>
					<p style="color: var(--surface-muted);">
						Manage your workspaces and projects
					</p>
				</div>
			<a href="/workspaces/new" class="btn btn-primary">
				<Plus class="h-4 w-4" />
				New Workspace
			</a>
		</div>

		{#if error}
			<div class="alert alert-error mb-6">{error}</div>
		{/if}

		{#if loading}
			<div class="flex justify-center py-12">
				<div class="text-center">
					<Loader2 class="mx-auto h-8 w-8 animate-spin text-primary-600" />
					<p class="mt-2 text-sm text-gray-600 dark:text-gray-400">Loading workspaces...</p>
				</div>
			</div>
		{:else if filteredWorkspaces.length === 0}
			<div class="card p-12 text-center">
				<div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full" style="background-color: var(--control-bg);">
					<FolderKanban class="h-6 w-6" style="color: var(--surface-muted);" />
				</div>
				<h3 class="mb-2 text-lg font-medium" style="color: var(--center-channel-color);">
					No workspaces yet
				</h3>
				<p class="mb-4" style="color: var(--surface-muted);">
					Create your first workspace to get started with your projects.
				</p>
				<a href="/workspaces/new" class="btn btn-primary">
					<Plus class="h-4 w-4" />
					Create Workspace
				</a>
			</div>
		{:else}
				<div class="flex flex-col gap-4" {...spatialMenu.root}>
					<label
						class="workspace-search flex items-center gap-3 rounded-2xl border px-4 py-2 text-sm shadow-sm transition"
					>
						<span class="text-xs font-semibold uppercase tracking-wide">
							Search
						</span>
						<input
							type="search"
							placeholder="Filter workspaces..."
							class="flex-1 bg-transparent text-base focus:outline-none"
							bind:value={searchQuery}
							{...spatialMenu.input}
						/>
					</label>

					{#if filteredWorkspaces.length > 0}
						<div class="max-h-[70vh] overflow-y-auto pr-1">
							<div
								class="grid gap-4 p-1"
								style:grid-template-columns="repeat(auto-fill,minmax(220px,1fr))"
							>
								{#each filteredWorkspaces as workspace}
									{@const href = `/workspaces/${workspace.slug}`}
									{@const item = spatialMenu.getItem(workspace, {
										onSelect: () => openWorkspace(workspace.slug)
									})}
									<a
										class={`workspace-card group flex h-full flex-col gap-4 rounded-2xl border p-4 text-left shadow-sm transition-all ${
											item.highlighted ? 'workspace-card--highlight' : ''
										}`}
										{...mergeAttrs(item.attrs, {
											href,
											onclick: event => handleWorkspaceClick(event as MouseEvent, workspace.slug)
										})}
									>
										<div class="flex items-start justify-between gap-4">
											<div>
												<p class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">
													Workspace
												</p>
												<h3
													class="mt-1 text-lg font-semibold transition-colors"
													style="color: var(--center-channel-color);"
												>
													{workspace.name}
												</h3>
											</div>
											<ArrowRight
												class="h-5 w-5 transition-all group-hover:translate-x-1"
												style="color: var(--surface-muted);"
											/>
										</div>
										{#if workspace.description}
											<p class="line-clamp-3 text-sm" style="color: var(--surface-muted);">
												{workspace.description}
											</p>
										{/if}
										<div
											class="mt-auto flex items-center justify-between text-sm"
											style="color: var(--surface-muted);"
										>
											<div class="flex items-center gap-1">
												<Users class="h-4 w-4" />
												<span>{workspace._count?.members ?? workspace.members?.length ?? 0} members</span>
										</div>
										<div class="flex items-center gap-1">
											<FolderKanban class="h-4 w-4" />
											<span>{workspace._count?.projects ?? workspace.projects?.length ?? 0} projects</span>
										</div>
									</div>
								</a>
							{/each}
						</div>
					</div>
				{:else}
					<div class="rounded-xl border border-dashed border-gray-300 p-8 text-center text-gray-600 dark:border-gray-700 dark:text-gray-400">
						<p class="text-lg font-medium">No workspaces match “{searchQuery}”.</p>
						<p class="mt-1 text-sm">Try a different search or clear the filter.</p>
					</div>
				{/if}
			</div>
		{/if}
	{/if}
</div>
