<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { user, apiFetch, toasts } from '$lib/stores';
	import { ArrowLeft, Github, Loader2, Link2, Unlink, KeyRound, Pencil, Trash2 } from 'lucide-svelte';

	let githubLinked = $state(false);
	let githubUsername = $state<string | null>(null);
	let loading = $state(true);
	let unlinking = $state(false);
let passkeys = $state<PasskeyRecord[]>([]);
let passkeysLoading = $state(true);
let passkeyListError = $state<string | null>(null);
let registerLoading = $state(false);
let newPasskeyName = $state('');
let editingPasskeyId = $state<string | null>(null);
let renameValue = $state('');
let renaming = $state(false);
let deletingPasskeyId = $state<string | null>(null);
let passkeyEnvWarning = $state<string | null>(null);

// Profile editing state
let editingProfile = $state(false);
let profileFirstName = $state('');
let profileLastName = $state('');
let profileUsername = $state('');
let savingProfile = $state(false);

	interface PasskeyRecord {
		id: string;
		friendlyName?: string | null;
		createdAt: string;
		lastUsedAt?: string | null;
		deviceType?: string | null;
		backedUp?: boolean;
		transports?: string[];
	}

	async function checkGitHubStatus() {
		loading = true;
		try {
			const response = await apiFetch('/apiv1/github/status');
			if (response.ok) {
				const data = await response.json();
				githubLinked = data.linked;
				githubUsername = data.username || null;
			}
		} catch (e) {
			console.error('Failed to check GitHub status:', e);
		} finally {
			loading = false;
		}
	}

	async function linkGitHub() {
		window.location.href = '/apiv1/github/link';
	}

	async function unlinkGitHub() {
		unlinking = true;
		try {
			const response = await apiFetch('/apiv1/github/unlink', {
				method: 'DELETE'
			});

			if (!response.ok) {
				throw new Error('Failed to unlink GitHub account');
			}

			githubLinked = false;
			githubUsername = null;

			toasts.add({
				title: 'GitHub Unlinked',
				description: 'Your GitHub account has been disconnected',
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to unlink GitHub',
				color: 'error'
			});
		} finally {
			unlinking = false;
		}
	}

	onMount(() => {
		if (browser && typeof window !== 'undefined' && !window.isSecureContext) {
			passkeyEnvWarning = `Passkeys require a secure origin (https:// or http://localhost). You're on ${window.location.origin}.`;
		}

		checkGitHubStatus();
		fetchPasskeys();
	});

	async function fetchPasskeys() {
		passkeysLoading = true;
		passkeyListError = null;

		try {
			const response = await apiFetch('/apiv1/auth/passkeys');
			if (!response.ok) {
				throw new Error('Failed to load passkeys');
			}

			const data = await response.json();
			passkeys = data.passkeys ?? [];
		} catch (err) {
			passkeyListError = err instanceof Error ? err.message : 'Could not load passkeys';
		} finally {
			passkeysLoading = false;
		}
	}

	async function registerPasskey() {
		if (registerLoading) return;

		if (!browser || typeof window === 'undefined') {
			toasts.add({
				title: 'Unsupported',
				description: 'Passkeys are not available in this environment.',
				color: 'error'
			});
			return;
		}

		if (!window.isSecureContext) {
			toasts.add({
				title: 'Use a secure origin',
				description: 'Passkeys require https:// or http://localhost.',
				color: 'error'
			});
			return;
		}

		if (!window.PublicKeyCredential) {
			toasts.add({
				title: 'Unsupported',
				description: 'Passkeys are not available on this device.',
				color: 'error'
			});
			return;
		}

		registerLoading = true;

		try {
			const optionsResponse = await apiFetch('/apiv1/auth/passkey/register/options', {
				method: 'POST'
			});

			if (!optionsResponse.ok) {
				throw new Error('Could not create passkey challenge');
			}

			const options = await optionsResponse.json();
			const { startRegistration } = await import('@simplewebauthn/browser');
			const credential = await startRegistration({
				optionsJSON: options
			});

			const verifyResponse = await apiFetch('/apiv1/auth/passkey/register/verify', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					response: credential,
					friendlyName: newPasskeyName.trim() || undefined
				})
			});

			if (!verifyResponse.ok) {
				const data = await verifyResponse.json().catch(() => ({}));
				throw new Error(data?.message || 'Passkey registration failed');
			}

			toasts.add({
				title: 'Passkey added',
				description: 'You can now sign in with this device.',
				color: 'success'
			});

			newPasskeyName = '';
			await fetchPasskeys();
		} catch (err) {
			const description =
				err instanceof Error
					? err.name === 'NotAllowedError'
						? 'Passkey prompt was cancelled.'
						: err.message
					: 'Failed to register passkey.';

			toasts.add({
				title: 'Unable to register passkey',
				description,
				color: 'error'
			});
		} finally {
			registerLoading = false;
		}
	}

	function startRenaming(passkey: PasskeyRecord) {
		editingPasskeyId = passkey.id;
		renameValue = passkey.friendlyName || '';
	}

	function cancelRenaming() {
		editingPasskeyId = null;
		renameValue = '';
	}

	async function savePasskeyName() {
		if (!editingPasskeyId) return;

		const friendlyName = renameValue.trim();
		if (!friendlyName) {
			toasts.add({
				title: 'Name required',
				description: 'Give this passkey a short name to recognize it later.',
				color: 'error'
			});
			return;
		}

		renaming = true;
		try {
			const response = await apiFetch(`/apiv1/auth/passkeys/${editingPasskeyId}/rename`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ friendlyName })
			});

			if (!response.ok) {
				throw new Error('Failed to rename passkey');
			}

			toasts.add({
				title: 'Passkey renamed',
				color: 'success'
			});

			cancelRenaming();
			await fetchPasskeys();
		} catch (err) {
			toasts.add({
				title: 'Rename failed',
				description: err instanceof Error ? err.message : 'Could not update name',
				color: 'error'
			});
		} finally {
			renaming = false;
		}
	}

	async function deletePasskey(passkey: PasskeyRecord) {
		if (deletingPasskeyId) return;

		const confirmed = window.confirm(`Remove "${passkey.friendlyName || 'this passkey'}"?`);
		if (!confirmed) return;

		deletingPasskeyId = passkey.id;

		try {
			const response = await apiFetch(`/apiv1/auth/passkeys/${passkey.id}`, {
				method: 'DELETE'
			});

			if (!response.ok) {
				throw new Error('Failed to delete passkey');
			}

			toasts.add({
				title: 'Passkey removed',
				color: 'success'
			});

			if (editingPasskeyId === passkey.id) {
				cancelRenaming();
			}

			await fetchPasskeys();
		} catch (err) {
			toasts.add({
				title: 'Unable to remove passkey',
				description: err instanceof Error ? err.message : 'Something went wrong',
				color: 'error'
			});
		} finally {
			deletingPasskeyId = null;
		}
	}

	function formatTimestamp(value?: string | null) {
		if (!value) return 'Not used yet';
		return new Date(value).toLocaleString(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		});
	}

	function startEditingProfile() {
		profileFirstName = $user?.firstName || '';
		profileLastName = $user?.lastName || '';
		profileUsername = $user?.username || '';
		editingProfile = true;
	}

	function cancelEditingProfile() {
		editingProfile = false;
		profileFirstName = '';
		profileLastName = '';
		profileUsername = '';
	}

	async function saveProfile() {
		if (savingProfile) return;

		// Validate username
		const trimmedUsername = profileUsername.trim();
		if (trimmedUsername && !/^[a-zA-Z0-9_-]+$/.test(trimmedUsername)) {
			toasts.add({
				title: 'Invalid username',
				description: 'Username can only contain letters, numbers, underscores, and hyphens',
				color: 'error'
			});
			return;
		}

		savingProfile = true;

		try {
			const response = await apiFetch('/apiv1/auth/me', {
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					firstName: profileFirstName.trim() || undefined,
					lastName: profileLastName.trim() || undefined,
					username: trimmedUsername || undefined
				})
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || 'Failed to update profile');
			}

			const updatedUser = await response.json();

			// Update the user store with the new data
			user.set({
				...$user,
				...updatedUser
			});

			toasts.add({
				title: 'Profile updated',
				color: 'success'
			});

			editingProfile = false;
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update profile',
				color: 'error'
			});
		} finally {
			savingProfile = false;
		}
	}
</script>

<div class="p-6">
	<div class="mb-6">
		<button
			onclick={() => window.history.back()}
			class="mb-4 inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 cursor-pointer"
		>
			<ArrowLeft class="h-4 w-4" />
			Back to workspace
		</button>
	</div>

	<div class="space-y-6">
		<!-- Header -->
		<div
			class="rounded-3xl border p-6 shadow-sm"
			style="background-color: var(--surface-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
		>
			<div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
				<div class="flex items-center gap-4">
					<div class="relative">
						{#if $user?.imageUrl}
							<img
								src={$user.imageUrl}
								alt={$user.name || 'User'}
								class="h-14 w-14 rounded-2xl object-cover ring-2 ring-gray-200 dark:ring-gray-700"
							/>
						{:else}
							<div
								class="flex h-14 w-14 items-center justify-center rounded-2xl ring-2 ring-gray-200 dark:ring-gray-700"
								style="background-color: color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-bg)); color: var(--center-channel-color);"
							>
								<span class="text-lg font-semibold">
									{$user?.firstName?.[0] || $user?.name?.[0] || 'U'}
								</span>
							</div>
						{/if}
					</div>
					<div>
						<p class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">User</p>
						<h1 class="text-2xl font-bold" style="color: var(--center-channel-color);">
							{#if $user?.firstName || $user?.lastName}
								{$user?.firstName || ''} {$user?.lastName || ''}
							{:else}
								{$user?.name || $user?.username || 'User'}
							{/if}
						</h1>
						<p class="mt-1 text-sm" style="color: var(--surface-muted);">
							{$user?.email || 'No email'}
						</p>
						{#if $user?.username}
							<p class="text-sm" style="color: var(--surface-muted);">@{$user.username}</p>
						{/if}
					</div>
				</div>
				<div class="flex flex-wrap gap-3 text-xs" style="color: var(--surface-muted);">
					<span
						class="rounded-full px-3 py-1 font-medium"
						style="background-color: var(--control-bg); border: 1px solid var(--surface-border); color: var(--center-channel-color);"
					>
						Email verified
					</span>
					<span
						class="rounded-full px-3 py-1 font-medium"
						style="background-color: var(--control-bg); border: 1px solid var(--surface-border); color: var(--center-channel-color);"
					>
						Account active
					</span>
				</div>
			</div>
		</div>

		<div class="grid gap-6 lg:grid-cols-[1.4fr,1fr]">
			<!-- Profile -->
			<div class="space-y-6">
				<div class="card">
					<div class="card-header flex items-center justify-between">
						<h2 class="font-semibold">Profile</h2>
						{#if !editingProfile}
							<button onclick={startEditingProfile} class="btn btn-secondary btn-sm">
								<Pencil class="h-4 w-4" />
								Edit
							</button>
						{/if}
					</div>
					<div class="card-body">
						<div class="grid gap-4 sm:grid-cols-2">
							<!-- First name -->
							<div class="rounded-2xl border p-4" style="background-color: var(--surface-bg); border-color: var(--surface-border);">
								<label for="profile-first-name" class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">First name</label>
								{#if editingProfile}
									<input
										id="profile-first-name"
										type="text"
										class="mt-1 w-full border-0 bg-transparent p-0 font-semibold outline-none focus:ring-0"
										style="color: var(--center-channel-color);"
										bind:value={profileFirstName}
										placeholder="First name"
									/>
								{:else}
									<p class="mt-2 font-semibold" style="color: var(--center-channel-color);">
										{$user?.firstName || '—'}
									</p>
								{/if}
							</div>
							<!-- Last name -->
							<div class="rounded-2xl border p-4" style="background-color: var(--surface-bg); border-color: var(--surface-border);">
								<label for="profile-last-name" class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">Last name</label>
								{#if editingProfile}
									<input
										id="profile-last-name"
										type="text"
										class="mt-1 w-full border-0 bg-transparent p-0 font-semibold outline-none focus:ring-0"
										style="color: var(--center-channel-color);"
										bind:value={profileLastName}
										placeholder="Last name"
									/>
								{:else}
									<p class="mt-2 font-semibold" style="color: var(--center-channel-color);">
										{$user?.lastName || '—'}
									</p>
								{/if}
							</div>
							<!-- Email (always read-only) -->
							<div class="rounded-2xl border p-4" style="background-color: var(--surface-bg); border-color: var(--surface-border);">
								<p class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">Email</p>
								<p class="mt-2 font-semibold" style="color: var(--center-channel-color);">
									{$user?.email || '—'}
								</p>
							</div>
							<!-- Username -->
							<div class="rounded-2xl border p-4" style="background-color: var(--surface-bg); border-color: var(--surface-border);">
								<label for="profile-username" class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">Username</label>
								{#if editingProfile}
									<input
										id="profile-username"
										type="text"
										class="mt-1 w-full border-0 bg-transparent p-0 font-mono text-sm outline-none focus:ring-0"
										style="color: var(--center-channel-color);"
										bind:value={profileUsername}
										placeholder="username"
									/>
								{:else}
									<p class="mt-2 font-mono text-sm" style="color: var(--center-channel-color);">
										{$user?.username || '—'}
									</p>
								{/if}
							</div>
						</div>
						{#if editingProfile}
							<div class="mt-4 flex gap-3">
								<button onclick={cancelEditingProfile} class="btn btn-secondary">
									Cancel
								</button>
								<button onclick={saveProfile} disabled={savingProfile} class="btn btn-primary">
									{#if savingProfile}
										<Loader2 class="h-4 w-4 animate-spin" />
									{/if}
									Save changes
								</button>
							</div>
						{/if}
					</div>
				</div>

				<!-- GitHub Integration -->
				<div class="card">
					<div class="card-header">
						<div class="flex items-center gap-2">
							<Github class="h-5 w-5" />
							<h2 class="text-lg font-semibold">GitHub Integration</h2>
						</div>
					</div>
					<div class="card-body space-y-4">
						{#if loading}
							<div class="flex items-center justify-center py-10">
								<Loader2 class="h-6 w-6 animate-spin text-primary-600" />
							</div>
						{:else if githubLinked}
							<div
								class="flex items-center justify-between rounded-2xl border p-4"
								style="background-color: var(--control-bg); border-color: var(--surface-border); color: var(--center-channel-color);"
							>
								<div class="flex items-center gap-3">
									<div class="flex h-10 w-10 items-center justify-center rounded-full bg-gray-900 dark:bg-white">
										<Github class="h-5 w-5 text-white dark:text-gray-900" />
									</div>
									<div>
										<p class="font-semibold" style="color: var(--center-channel-color);">
											Connected to GitHub
										</p>
										{#if githubUsername}
											<p class="text-sm" style="color: var(--surface-muted);">
												@{githubUsername}
											</p>
										{/if}
									</div>
								</div>
								<button onclick={unlinkGitHub} disabled={unlinking} class="btn btn-secondary">
									{#if unlinking}
										<Loader2 class="h-4 w-4 animate-spin" />
									{:else}
										<Unlink class="h-4 w-4" />
									{/if}
									Disconnect
								</button>
							</div>
							<div class="rounded-2xl border p-4" style="background-color: var(--surface-bg); border-color: var(--surface-border);">
								<p class="text-sm font-medium" style="color: var(--center-channel-color);">
									You can now:
								</p>
								<ul class="mt-2 list-inside list-disc text-sm" style="color: var(--surface-muted);">
									<li>Deploy directly from your GitHub repositories</li>
									<li>Auto-build images from commits</li>
									<li>View deployment history with commit info</li>
								</ul>
							</div>
						{:else}
							<div
								class="rounded-2xl border-2 border-dashed p-6 text-center"
								style="border-color: var(--surface-border); color: var(--center-channel-color);"
							>
								<Github class="mx-auto h-12 w-12 text-gray-400" />
								<h3 class="mt-4 font-semibold" style="color: var(--center-channel-color);">
									Connect your GitHub account
								</h3>
								<p class="mt-2 text-sm" style="color: var(--surface-muted);">
									Link GitHub to deploy straight from your repos.
								</p>
								<button onclick={linkGitHub} class="btn btn-primary mt-4">
									<Link2 class="h-4 w-4" />
									Connect GitHub
								</button>
							</div>
							<div class="rounded-2xl border p-4" style="background-color: var(--surface-bg); border-color: var(--surface-border);">
								<p class="text-sm font-medium" style="color: var(--center-channel-color);">
									Why connect GitHub?
								</p>
								<ul class="mt-2 list-inside list-disc text-sm" style="color: var(--surface-muted);">
									<li>Deploy directly from your repositories</li>
									<li>Automatic image builds from commits</li>
									<li>View deployment history with commit information</li>
								</ul>
							</div>
						{/if}
					</div>
				</div>

				<!-- Passkeys -->
				<div class="card">
					<div class="card-header space-y-3 md:space-y-0">
						<div class="flex items-center gap-2">
							<KeyRound class="h-5 w-5" />
							<h2 class="text-lg font-semibold">Passkeys</h2>
						</div>
						<div class="mt-4 flex flex-col gap-3 md:mt-0 md:flex-row md:items-center">
							<input
								class="input md:max-w-xs"
								type="text"
								placeholder="Device name (optional)"
								bind:value={newPasskeyName}
							/>
							<button
								class="btn btn-primary"
								type="button"
								onclick={registerPasskey}
								disabled={registerLoading}
							>
								{#if registerLoading}
									<Loader2 class="h-4 w-4 animate-spin" />
								{/if}
								Register passkey
							</button>
						</div>
					</div>
						<div class="card-body space-y-4">
							<p class="text-sm" style="color: var(--surface-muted);">
								Use passkeys to sign in without waiting for OTP emails. They work great with Touch ID, Face ID, and Windows Hello.
							</p>

							{#if passkeyEnvWarning}
								<div class="rounded-2xl border border-yellow-200 bg-yellow-50/80 p-3 text-sm text-yellow-900 dark:border-yellow-900/40 dark:bg-yellow-900/20 dark:text-yellow-100">
									{passkeyEnvWarning}
								</div>
							{/if}

							{#if passkeyListError}
								<div
									class="rounded-2xl border p-4 text-sm"
								style="border-color: rgba(220,53,69,0.4); color: var(--error-text-color); background-color: color-mix(in srgb, var(--error-text-color) 7%, transparent);"
							>
								{passkeyListError}
							</div>
						{/if}

						{#if passkeysLoading}
							<div class="flex items-center justify-center py-8">
								<Loader2 class="h-5 w-5 animate-spin text-primary-600" />
							</div>
						{:else if passkeys.length === 0}
							<div
								class="rounded-2xl border-2 border-dashed p-6 text-center"
								style="border-color: var(--surface-border); color: var(--surface-muted);"
							>
								<p class="font-semibold" style="color: var(--center-channel-color);">
									No passkeys yet
								</p>
								<p class="mt-1 text-sm">
									Register a passkey on a device that supports Touch ID, Face ID, or Windows Hello.
								</p>
							</div>
						{:else}
							<div class="space-y-3">
								{#each passkeys as passkey}
									<div
										class="rounded-2xl border p-4"
										style="background-color: var(--surface-bg); border-color: var(--surface-border);"
									>
										<div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
											<div class="flex-1 space-y-1">
												<p class="text-sm font-semibold" style="color: var(--center-channel-color);">
													{passkey.friendlyName || 'Passkey'}
												</p>
												<p class="text-xs uppercase tracking-wide" style="color: var(--surface-muted);">
													Last used {formatTimestamp(passkey.lastUsedAt)}
												</p>
												<p class="text-xs" style="color: var(--surface-muted);">
													Added {formatTimestamp(passkey.createdAt)} · {passkey.deviceType === 'multiDevice' ? 'Synced device' : 'Device specific'}
												</p>
											</div>
											<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
												{#if editingPasskeyId === passkey.id}
													<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
														<input
															class="input sm:w-48"
															type="text"
															placeholder="Friendly name"
															bind:value={renameValue}
														/>
														<div class="flex gap-2">
															<button
																class="btn btn-primary"
																type="button"
																onclick={savePasskeyName}
																disabled={renaming}
															>
																{#if renaming}
																	<Loader2 class="h-4 w-4 animate-spin" />
																{/if}
																Save
															</button>
															<button class="btn btn-secondary" type="button" onclick={cancelRenaming}>
																Cancel
															</button>
														</div>
													</div>
												{:else}
													<div class="flex gap-2">
														<button class="btn btn-secondary" type="button" onclick={() => startRenaming(passkey)}>
															<Pencil class="h-4 w-4" />
															Rename
														</button>
														<button
															class="btn btn-ghost text-red-600"
															type="button"
															onclick={() => deletePasskey(passkey)}
															disabled={deletingPasskeyId === passkey.id}
														>
															{#if deletingPasskeyId === passkey.id}
																<Loader2 class="h-4 w-4 animate-spin" />
															{:else}
																<Trash2 class="h-4 w-4" />
															{/if}
															Remove
														</button>
													</div>
												{/if}
											</div>
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			</div>

			<!-- Quick actions -->
			<div class="space-y-6">
				<div class="card">
					<div class="card-header">
						<h2 class="font-semibold">Security</h2>
					</div>
					<div class="card-body space-y-3">
						<div class="rounded-2xl border p-4" style="background-color: var(--control-bg); border-color: var(--surface-border);">
							<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Two-factor authentication</p>
							<p class="text-sm" style="color: var(--surface-muted);">Manage 2FA from your identity provider.</p>
						</div>
						<div class="rounded-2xl border p-4" style="background-color: var(--control-bg); border-color: var(--surface-border);">
							<p class="text-sm font-semibold" style="color: var(--center-channel-color);">Sessions</p>
							<p class="text-sm" style="color: var(--surface-muted);">Sign out from other devices in account settings.</p>
						</div>
					</div>
				</div>

				<div class="card">
					<div class="card-header">
						<h2 class="font-semibold">Support</h2>
					</div>
					<div class="card-body space-y-2">
						<p class="text-sm" style="color: var(--surface-muted);">
							Need help or want to revoke access? Contact support and we’ll assist.
						</p>
						<a href="mailto:support@orchard.dev" class="btn btn-secondary w-full justify-center">Email support</a>
					</div>
				</div>
			</div>
		</div>
	</div>
</div>
