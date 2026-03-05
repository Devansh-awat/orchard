<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { user, apiFetch, toasts } from '$lib/stores';
	import { ArrowLeft, Github, Loader2, Link2, Unlink, KeyRound, Pencil, Trash2, User, ChevronRight, Eye, EyeOff } from 'lucide-svelte';

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

	// Email visibility
	let emailRevealed = $state(false);

	function censorEmail(email: string): string {
		const [local, domain] = email.split('@');
		if (!domain) return '••••••';
		const visibleStart = local.slice(0, 2);
		const visibleDomain = domain;
		return `${visibleStart}${'•'.repeat(Math.max(local.length - 2, 3))}@${visibleDomain}`;
	}

	let displayEmail = $derived.by(() => {
		const email = $user?.email || '';
		if (!email) return '';
		return emailRevealed ? email : censorEmail(email);
	});

	// Section collapse state
	let expandedSection = $state<string | null>(null);

	function toggleSection(section: string) {
		expandedSection = expandedSection === section ? null : section;
	}

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

<div class="settings-page">
	<div class="settings-container">
		<!-- Header -->
		<div class="settings-header">
			<button
				onclick={() => window.history.back()}
				class="settings-back-btn"
			>
				<ArrowLeft class="h-4 w-4" />
				Back
			</button>

			<div class="settings-title-row">
				<div class="settings-avatar">
					{#if $user?.imageUrl}
						<img
							src={$user.imageUrl}
							alt={$user.name || 'User'}
							class="settings-avatar-img"
						/>
					{:else}
						<span class="settings-avatar-letter">
							{$user?.firstName?.[0] || $user?.name?.[0] || 'U'}
						</span>
					{/if}
				</div>
				<div>
					<h1 class="settings-title">
						{#if $user?.firstName || $user?.lastName}
							{$user?.firstName || ''} {$user?.lastName || ''}
						{:else}
							{$user?.name || $user?.username || 'User'}
						{/if}
					</h1>
					<p class="settings-subtitle">
						{displayEmail}
						<button
							class="settings-reveal-btn"
							onclick={() => emailRevealed = !emailRevealed}
							aria-label={emailRevealed ? 'Hide email' : 'Show email'}
						>
							{#if emailRevealed}
								<EyeOff class="h-3 w-3" />
							{:else}
								<Eye class="h-3 w-3" />
							{/if}
						</button>
					</p>
				</div>
			</div>
		</div>

		<!-- Profile Section -->
		<section class="settings-section">
			<button class="settings-section-trigger" onclick={() => toggleSection('profile')}>
				<div class="settings-section-trigger-left">
					<User class="h-4 w-4" />
					<div>
						<p class="settings-section-label">Profile</p>
						<p class="settings-section-desc">Name, email, and username</p>
					</div>
				</div>
				<span class="settings-section-chevron" class:is-open={expandedSection === 'profile'}><ChevronRight class="h-4 w-4" /></span>
			</button>

			{#if expandedSection === 'profile'}
				<div class="settings-section-content">
					{#if editingProfile}
						<div class="settings-field-grid">
							<div class="settings-field">
								<label for="profile-first-name" class="settings-field-label">First name</label>
								<input
									id="profile-first-name"
									type="text"
									class="input"
									bind:value={profileFirstName}
									placeholder="First name"
								/>
							</div>
							<div class="settings-field">
								<label for="profile-last-name" class="settings-field-label">Last name</label>
								<input
									id="profile-last-name"
									type="text"
									class="input"
									bind:value={profileLastName}
									placeholder="Last name"
								/>
							</div>
							<div class="settings-field">
								<label class="settings-field-label">Email</label>
								<p class="settings-field-value">{displayEmail || '—'}</p>
							</div>
							<div class="settings-field">
								<label for="profile-username" class="settings-field-label">Username</label>
								<input
									id="profile-username"
									type="text"
									class="input font-mono text-sm"
									bind:value={profileUsername}
									placeholder="username"
								/>
							</div>
						</div>
						<div class="settings-actions">
							<button onclick={cancelEditingProfile} class="btn btn-secondary">Cancel</button>
							<button onclick={saveProfile} disabled={savingProfile} class="btn btn-primary">
								{#if savingProfile}<Loader2 class="h-4 w-4 animate-spin" />{/if}
								Save
							</button>
						</div>
					{:else}
						<div class="settings-field-grid">
							<div class="settings-field">
								<p class="settings-field-label">First name</p>
								<p class="settings-field-value">{$user?.firstName || '—'}</p>
							</div>
							<div class="settings-field">
								<p class="settings-field-label">Last name</p>
								<p class="settings-field-value">{$user?.lastName || '—'}</p>
							</div>
							<div class="settings-field">
								<p class="settings-field-label">Email</p>
								<p class="settings-field-value">{displayEmail || '—'}</p>
							</div>
							<div class="settings-field">
								<p class="settings-field-label">Username</p>
								<p class="settings-field-value font-mono text-sm">{$user?.username || '—'}</p>
							</div>
						</div>
						<div class="settings-actions">
							<button onclick={startEditingProfile} class="btn btn-secondary">
								<Pencil class="h-4 w-4" />
								Edit profile
							</button>
						</div>
					{/if}
				</div>
			{/if}
		</section>

		<!-- GitHub Section -->
		<section class="settings-section">
			<button class="settings-section-trigger" onclick={() => toggleSection('github')}>
				<div class="settings-section-trigger-left">
					<Github class="h-4 w-4" />
					<div>
						<p class="settings-section-label">GitHub</p>
						<p class="settings-section-desc">
							{#if loading}
								Checking status...
							{:else if githubLinked}
								Connected as @{githubUsername}
							{:else}
								Not connected
							{/if}
						</p>
					</div>
				</div>
				<div class="flex items-center gap-2">
					{#if !loading}
						<span class="settings-status-dot" class:is-connected={githubLinked}></span>
					{/if}
					<span class="settings-section-chevron" class:is-open={expandedSection === 'github'}><ChevronRight class="h-4 w-4" /></span>
				</div>
			</button>

			{#if expandedSection === 'github'}
				<div class="settings-section-content">
					{#if loading}
						<div class="flex items-center justify-center py-6">
							<Loader2 class="h-5 w-5 animate-spin text-primary-600" />
						</div>
					{:else if githubLinked}
						<div class="settings-connected-row">
							<div class="flex items-center gap-3">
								<div class="settings-github-avatar">
									<Github class="h-4 w-4" />
								</div>
								<p class="settings-field-value">@{githubUsername}</p>
							</div>
							<button onclick={unlinkGitHub} disabled={unlinking} class="btn btn-secondary">
								{#if unlinking}<Loader2 class="h-4 w-4 animate-spin" />{:else}<Unlink class="h-4 w-4" />{/if}
								Disconnect
							</button>
						</div>
					{:else}
						<div class="settings-empty-state">
							<p class="settings-field-value">Connect GitHub to deploy from your repos</p>
							<p class="settings-field-label">Auto-build images from commits and view deployment history</p>
							<button onclick={linkGitHub} class="btn btn-primary mt-3">
								<Link2 class="h-4 w-4" />
								Connect GitHub
							</button>
						</div>
					{/if}
				</div>
			{/if}
		</section>

		<!-- Passkeys Section -->
		<section class="settings-section">
			<button class="settings-section-trigger" onclick={() => toggleSection('passkeys')}>
				<div class="settings-section-trigger-left">
					<KeyRound class="h-4 w-4" />
					<div>
						<p class="settings-section-label">Passkeys</p>
						<p class="settings-section-desc">
							{#if passkeysLoading}
								Loading...
							{:else}
								{passkeys.length} registered
							{/if}
						</p>
					</div>
				</div>
				<span class="settings-section-chevron" class:is-open={expandedSection === 'passkeys'}><ChevronRight class="h-4 w-4" /></span>
			</button>

			{#if expandedSection === 'passkeys'}
				<div class="settings-section-content">
					<p class="settings-hint">
						Sign in without OTP emails using Touch ID, Face ID, or Windows Hello.
					</p>

					{#if passkeyEnvWarning}
						<div class="alert alert-warning">{passkeyEnvWarning}</div>
					{/if}

					{#if passkeyListError}
						<div class="alert alert-error">{passkeyListError}</div>
					{/if}

					<!-- Add passkey -->
					<div class="settings-passkey-add">
						<input
							class="input flex-1"
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
							{#if registerLoading}<Loader2 class="h-4 w-4 animate-spin" />{/if}
							Add passkey
						</button>
					</div>

					{#if passkeysLoading}
						<div class="flex items-center justify-center py-6">
							<Loader2 class="h-5 w-5 animate-spin text-primary-600" />
						</div>
					{:else if passkeys.length === 0}
						<p class="settings-hint" style="text-align: center; padding: 1rem 0;">No passkeys registered yet.</p>
					{:else}
						<div class="settings-passkey-list">
							{#each passkeys as passkey}
								<div class="settings-passkey-item">
									<div class="flex-1 min-w-0">
										{#if editingPasskeyId === passkey.id}
											<div class="flex items-center gap-2">
												<input
													class="input flex-1"
													type="text"
													placeholder="Friendly name"
													bind:value={renameValue}
												/>
												<button class="btn btn-primary" type="button" onclick={savePasskeyName} disabled={renaming}>
													{#if renaming}<Loader2 class="h-4 w-4 animate-spin" />{/if}
													Save
												</button>
												<button class="btn btn-secondary" type="button" onclick={cancelRenaming}>Cancel</button>
											</div>
										{:else}
											<p class="settings-field-value">{passkey.friendlyName || 'Passkey'}</p>
											<p class="settings-field-label">
												Last used {formatTimestamp(passkey.lastUsedAt)} · Added {formatTimestamp(passkey.createdAt)}
											</p>
										{/if}
									</div>
									{#if editingPasskeyId !== passkey.id}
										<div class="flex gap-1">
											<button class="btn btn-ghost" type="button" onclick={() => startRenaming(passkey)} title="Rename">
												<Pencil class="h-3.5 w-3.5" />
											</button>
											<button
												class="btn btn-ghost"
												type="button"
												onclick={() => deletePasskey(passkey)}
												disabled={deletingPasskeyId === passkey.id}
												title="Remove"
												style="color: var(--error-text-color);"
											>
												{#if deletingPasskeyId === passkey.id}
													<Loader2 class="h-3.5 w-3.5 animate-spin" />
												{:else}
													<Trash2 class="h-3.5 w-3.5" />
												{/if}
											</button>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</section>
	</div>
</div>

<style>
	.settings-page {
		padding: 2rem;
		max-width: 42rem;
		margin: 0 auto;
	}

	.settings-container {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.settings-header {
		margin-bottom: 1.5rem;
	}

	.settings-back-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		color: var(--surface-muted);
		cursor: pointer;
		margin-bottom: 1rem;
		transition: color 120ms ease;
	}

	.settings-back-btn:hover {
		color: var(--center-channel-color);
	}

	.settings-title-row {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.settings-avatar {
		width: 3rem;
		height: 3rem;
		border-radius: 0.75rem;
		overflow: hidden;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background-color: color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-bg));
		color: var(--center-channel-color);
	}

	.settings-avatar-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.settings-avatar-letter {
		font-size: 1.125rem;
		font-weight: 600;
	}

	.settings-title {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--center-channel-color);
		line-height: 1.3;
	}

	.settings-subtitle {
		font-size: 0.875rem;
		color: var(--surface-muted);
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.settings-reveal-btn {
		display: inline-flex;
		align-items: center;
		padding: 0.125rem;
		border-radius: 0.25rem;
		color: var(--surface-muted);
		background: transparent;
		cursor: pointer;
		transition: color 120ms ease, background-color 120ms ease;
	}

	.settings-reveal-btn:hover {
		color: var(--center-channel-color);
		background-color: var(--control-hover-bg);
	}

	/* Sections */
	.settings-section {
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		overflow: hidden;
		background-color: var(--surface-bg);
		margin-bottom: 0.5rem;
	}

	.settings-section-trigger {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 1rem 1.25rem;
		cursor: pointer;
		background: transparent;
		color: var(--center-channel-color);
		transition: background-color 120ms ease;
	}

	.settings-section-trigger:hover {
		background-color: var(--control-hover-bg);
	}

	.settings-section-trigger-left {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.settings-section-label {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--center-channel-color);
		text-align: left;
	}

	.settings-section-desc {
		font-size: 0.75rem;
		color: var(--surface-muted);
		text-align: left;
	}

	.settings-section-chevron {
		color: var(--surface-muted);
		transition: transform 200ms ease;
		flex-shrink: 0;
	}

	.settings-section-chevron.is-open {
		transform: rotate(90deg);
	}

	.settings-section-content {
		padding: 0 1.25rem 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		border-top: 1px solid var(--surface-border);
		padding-top: 1rem;
	}

	/* Fields */
	.settings-field-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}

	@media (max-width: 480px) {
		.settings-field-grid {
			grid-template-columns: 1fr;
		}
	}

	.settings-field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.settings-field-label {
		font-size: 0.6875rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--surface-muted);
	}

	.settings-field-value {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--center-channel-color);
	}

	.settings-actions {
		display: flex;
		gap: 0.5rem;
		padding-top: 0.25rem;
	}

	.settings-hint {
		font-size: 0.8125rem;
		color: var(--surface-muted);
	}

	/* Status dot */
	.settings-status-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background-color: var(--surface-muted);
	}

	.settings-status-dot.is-connected {
		background-color: var(--online-indicator);
	}

	/* GitHub */
	.settings-connected-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.settings-github-avatar {
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		background-color: var(--center-channel-color);
		color: var(--center-channel-bg);
		flex-shrink: 0;
	}

	.settings-empty-state {
		text-align: center;
		padding: 0.5rem 0;
	}

	/* Passkeys */
	.settings-passkey-add {
		display: flex;
		gap: 0.5rem;
	}

	.settings-passkey-list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.settings-passkey-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
	}
</style>
