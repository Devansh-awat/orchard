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
		Mail,
		KeyRound,
		ShieldCheck
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
		<!-- Landing page for unauthenticated users -->
		<div class="min-h-[90vh] px-2 py-6 sm:px-8 sm:py-12">
			<div class="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[1.1fr,0.9fr]">
				<section
					class="rounded-3xl border p-8 shadow-sm"
					style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
				>
					<div class="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide"
						style="background-color: var(--control-bg); color: var(--surface-muted); border: 1px solid var(--surface-border);">
						<ShieldCheck class="h-4 w-4" />
						Secure Access
					</div>
					<div class="mt-6 space-y-4">
						<h1 class="text-3xl font-bold leading-tight">
							Welcome to Orchard
						</h1>
						<p class="text-base" style="color: var(--surface-muted);">
							Orchard keeps Kubernetes approachable with guided workspaces, observability, and automated deployments.
							Choose the sign-in method that works best for you.
						</p>
					</div>
					<ul class="mt-8 space-y-4 text-sm">
						<li class="flex items-start gap-3">
							<div class="rounded-full bg-primary-600/10 p-2 text-primary-600">
								<FolderKanban class="h-4 w-4" />
							</div>
							<div>
								<p class="font-semibold">Collaborative workspaces</p>
								<p class="text-sm" style="color: var(--surface-muted);">
									Share clusters, manage deployments, and keep your team on the same page.
								</p>
							</div>
						</li>
						<li class="flex items-start gap-3">
							<div class="rounded-full bg-primary-600/10 p-2 text-primary-600">
								<Users class="h-4 w-4" />
							</div>
							<div>
								<p class="font-semibold">Flexible authentication</p>
								<p class="text-sm" style="color: var(--surface-muted);">
									Use email OTPs, passkeys, or continue with Hack Club login.
								</p>
							</div>
						</li>
					</ul>
					<div class="mt-10 flex flex-col gap-3 sm:flex-row">
						<button class="btn btn-primary w-full sm:w-auto px-6 py-3 text-base" onclick={() => user.signIn()}>
							Continue with Hack Club
						</button>
					</div>
				</section>

				<div class="space-y-4">
					<div class="card p-6 space-y-5">
						<div class="flex items-center gap-3">
							<div class="rounded-2xl bg-primary-600/10 p-3 text-primary-600">
								<Mail class="h-5 w-5" />
							</div>
							<div>
								<p class="text-sm font-semibold uppercase" style="color: var(--surface-muted);">
									Email sign-in
								</p>
								<h2 class="text-xl font-semibold">One-time passcode</h2>
							</div>
						</div>
							<form
								class="space-y-4"
								novalidate
								onsubmit={(event) => {
								event.preventDefault();
								if (otpStep === 'email') {
									requestOtp();
								} else {
									verifyOtp();
								}
							}}
						>
								<div class="space-y-1">
									<label
										for="otp-email"
										class="text-xs uppercase tracking-wide"
										style="color: var(--surface-muted);"
									>
										Work email
									</label>
									<input
										class="input"
										type="email"
										placeholder="you@company.com"
										id="otp-email"
										bind:value={otpEmail}
										autocomplete="email"
										required
									/>
								</div>
								{#if otpStep === 'code'}
									<div class="space-y-1">
										<div class="flex items-center justify-between text-xs uppercase tracking-wide" style="color: var(--surface-muted);">
											<label for="otp-code">6-digit code</label>
											<button
												type="button"
												class="text-[11px] font-semibold uppercase text-primary-600 hover:text-primary-700"
											onclick={() => {
												otpStep = 'email';
												otpCode = '';
												otpMessage = null;
											}}
										>
											Use another email
											</button>
										</div>
										<input
											class="input"
											type="text"
											inputmode="numeric"
											maxlength="6"
											placeholder="••••••"
											id="otp-code"
											bind:value={otpCode}
											autocomplete="one-time-code"
										/>
									</div>
								{/if}

							{#if otpError}
								<p class="text-sm text-red-500">{otpError}</p>
							{/if}
							{#if otpMessage}
								<p class="text-sm text-green-600">{otpMessage}</p>
							{/if}

							<button
								class="btn btn-primary w-full"
								type="submit"
								disabled={otpRequesting || otpVerifying}
							>
								{#if otpRequesting || otpVerifying}
									<Loader2 class="h-4 w-4 animate-spin" />
								{/if}
								{otpStep === 'email' ? 'Send code' : 'Verify and sign in'}
							</button>
						</form>
					</div>

					<div class="card p-6 space-y-5">
						<div class="flex items-center gap-3">
							<div class="rounded-2xl bg-primary-600/10 p-3 text-primary-600">
								<KeyRound class="h-5 w-5" />
							</div>
							<div>
								<p class="text-sm font-semibold uppercase" style="color: var(--surface-muted);">
									Passkey
								</p>
								<h2 class="text-xl font-semibold">Use a saved device</h2>
							</div>
						</div>
						{#if passkeySupported}
							<div class="space-y-3">
								<div class="space-y-1">
									<label
										for="passkey-email"
										class="text-xs uppercase tracking-wide"
										style="color: var(--surface-muted);"
									>
										Account email (optional)
									</label>
									<input
										class="input"
										type="email"
										placeholder="Helps us pick the right passkey"
										id="passkey-email"
										bind:value={passkeyEmail}
									/>
								</div>
								<button
									class="btn btn-secondary w-full"
									type="button"
									onclick={signInWithPasskey}
									disabled={passkeyLoading}
								>
									{#if passkeyLoading}
										<Loader2 class="h-4 w-4 animate-spin" />
									{/if}
									Use passkey
								</button>
								{#if passkeyError}
									<p class="text-sm text-red-500">{passkeyError}</p>
								{/if}
								<p class="text-xs" style="color: var(--surface-muted);">
									Use Touch ID, Face ID, or Windows Hello. Need to register one? Sign in and add it from your settings.
								</p>
							</div>
						{:else}
							<p class="text-sm" style="color: var(--surface-muted);">
								{passkeySupportReason ??
									'Passkeys aren’t available in this browser. Try Chrome, Safari, or Edge on a device with Face ID, Touch ID, or Windows Hello support.'}
							</p>
						{/if}
					</div>
				</div>
			</div>
		</div>
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
