<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { user, apiFetch, toasts, pendingInvitations, organizations, type PendingInvitation } from '$lib/stores';
	import { ArrowLeft, Github, Loader2, Unlink, Trash2, Eye, EyeOff, Check, X, Plus, Fingerprint, ChevronRight, Pencil, Mail, Building2, Monitor, Smartphone, Globe, LogOut, Camera } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';

	let githubLinked = $state(false);
	let githubUsername = $state<string | null>(null);
	let loading = $state(true);
	let unlinking = $state(false);
	let githubInstallations = $state<Array<{ id: string; installationId: string; accountLogin: string; accountType: string; repositorySelection: string }>>([]);
	let githubAppInstallUrl = $state<string | null>(null);

	// Tailscale
	let tailscaleLinked = $state(false);
	let tailscaleTailnet = $state<string | null>(null);
	let tailscaleLoading = $state(true);
	let unlinkingTailscale = $state(false);
	let tailscaleApiKey = $state('');
	let linkingTailscale = $state(false);
	let showTailscaleForm = $state(false);
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

	// Inline field editing
	let editingField = $state<string | null>(null);
	let editValue = $state('');
	let savingField = $state(false);

	// Delete passkey modal
	let showDeletePasskeyModal = $state(false);
	let passkeyToDelete = $state<PasskeyRecord | null>(null);

	// Email visibility
	let emailRevealed = $state(false);

	// Avatar upload
	let uploadingAvatar = $state(false);
	let deletingAvatar = $state(false);
	let avatarInput: HTMLInputElement;

	// Add passkey flow
	let showAddPasskey = $state(false);

	// Invitations
	let acceptingInvitation = $state<string | null>(null);
	let decliningInvitation = $state<string | null>(null);
	const invitations = $derived($pendingInvitations);

	// Sessions
	interface SessionRecord {
		id: string;
		ipAddress?: string | null;
		deviceName?: string | null;
		location?: string | null;
		authMethod?: string | null;
		lastActiveAt: string;
		createdAt: string;
		isCurrent: boolean;
	}
	let sessions = $state<SessionRecord[]>([]);
	let sessionsLoading = $state(true);
	let sessionsError = $state<string | null>(null);
	let revokingSessionId = $state<string | null>(null);
	let revokingAll = $state(false);
	let showRevokeAllModal = $state(false);
	let sessionToRevoke = $state<SessionRecord | null>(null);
	let showRevokeSessionModal = $state(false);

	async function handleAcceptInvitation(invitation: PendingInvitation) {
		if (acceptingInvitation || decliningInvitation) return;
		acceptingInvitation = invitation.token;
		try {
			await pendingInvitations.accept(invitation.token);
			const orgsResponse = await apiFetch('/apiv1/organizations/user');
			if (orgsResponse.ok) {
				const orgs = await orgsResponse.json();
				organizations.set(orgs);
				organizations.initializeSelected();
			}
			toasts.add({ title: 'Welcome!', description: `You've joined ${invitation.organization.name}`, color: 'success' });
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to accept invitation', color: 'error' });
		} finally {
			acceptingInvitation = null;
		}
	}

	async function handleDeclineInvitation(invitation: PendingInvitation) {
		if (acceptingInvitation || decliningInvitation) return;
		decliningInvitation = invitation.token;
		try {
			await pendingInvitations.decline(invitation.token);
			toasts.add({ title: 'Invitation declined', color: 'success' });
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to decline invitation', color: 'error' });
		} finally {
			decliningInvitation = null;
		}
	}

	function censorEmail(email: string): string {
		const [local, domain] = email.split('@');
		if (!domain) return '••••••';
		const visibleStart = local.slice(0, 2);
		return `${visibleStart}${'•'.repeat(Math.max(local.length - 2, 3))}@${domain}`;
	}

	let displayEmail = $derived.by(() => {
		const email = $user?.email || '';
		if (!email) return '';
		return emailRevealed ? email : censorEmail(email);
	});

	interface PasskeyRecord {
		id: string;
		friendlyName?: string | null;
		createdAt: string;
		lastUsedAt?: string | null;
		deviceType?: string | null;
		backedUp?: boolean;
		transports?: string[];
	}

	function startEditField(field: string) {
		if (field === 'firstName') editValue = $user?.firstName || '';
		else if (field === 'lastName') editValue = $user?.lastName || '';
		else if (field === 'username') editValue = $user?.username || '';
		editingField = field;
	}

	function cancelEditField() {
		editingField = null;
		editValue = '';
	}

	async function saveField() {
		if (savingField || !editingField) return;

		const trimmed = editValue.trim();
		if (editingField === 'username' && trimmed && !/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
			toasts.add({ title: 'Invalid username', description: 'Letters, numbers, underscores, and hyphens only', color: 'error' });
			return;
		}

		savingField = true;
		try {
			const body: Record<string, string | undefined> = {};
			body[editingField] = trimmed || undefined;

			const response = await apiFetch('/apiv1/auth/me', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || 'Failed to update');
			}

			const updatedUser = await response.json();
			user.set({ ...$user, ...updatedUser });
			toasts.add({ title: 'Updated', color: 'success' });
			editingField = null;
			editValue = '';
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to update', color: 'error' });
		} finally {
			savingField = false;
		}
	}

	function handleFieldKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') saveField();
		else if (e.key === 'Escape') cancelEditField();
	}

	async function uploadAvatar(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
		if (!allowedTypes.includes(file.type)) {
			toasts.add({ title: 'Invalid file type', description: 'Only JPEG, PNG, GIF, and WebP images are allowed', color: 'error' });
			return;
		}
		if (file.size > 5 * 1024 * 1024) {
			toasts.add({ title: 'File too large', description: 'Maximum file size is 5MB', color: 'error' });
			return;
		}

		uploadingAvatar = true;
		try {
			const formData = new FormData();
			formData.append('file', file);
			const response = await apiFetch('/apiv1/auth/me/avatar', { method: 'POST', body: formData });
			if (!response.ok) throw new Error('Failed to upload avatar');
			const updated = await response.json();
			user.set({ ...$user, ...updated });
			toasts.add({ title: 'Avatar updated', color: 'success' });
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to upload avatar', color: 'error' });
		} finally {
			uploadingAvatar = false;
			if (avatarInput) avatarInput.value = '';
		}
	}

	async function deleteAvatar() {
		deletingAvatar = true;
		try {
			const response = await apiFetch('/apiv1/auth/me/avatar', { method: 'DELETE' });
			if (!response.ok) throw new Error('Failed to remove avatar');
			const updated = await response.json();
			user.set({ ...$user, ...updated });
			toasts.add({ title: 'Avatar removed', color: 'success' });
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to remove avatar', color: 'error' });
		} finally {
			deletingAvatar = false;
		}
	}

	async function checkGitHubStatus() {
		loading = true;
		try {
			const response = await apiFetch('/apiv1/github/status');
			if (response.ok) {
				const data = await response.json();
				githubLinked = data.linked;
				githubUsername = data.username || null;
				githubInstallations = data.installations ?? [];
			}
			const installRes = await apiFetch('/apiv1/github/app/install');
			if (installRes.ok) {
				const data = await installRes.json();
				githubAppInstallUrl = data.url;
			}
		} catch (e) {
			console.error('Failed to check GitHub status:', e);
		} finally {
			loading = false;
		}
	}

	async function linkGitHub() { window.location.href = '/apiv1/github/link'; }

	async function unlinkGitHub() {
		unlinking = true;
		try {
			const response = await apiFetch('/apiv1/github/unlink', { method: 'DELETE' });
			if (!response.ok) throw new Error('Failed to unlink GitHub account');
			githubLinked = false;
			githubUsername = null;
			toasts.add({ title: 'GitHub Unlinked', description: 'Your GitHub account has been disconnected', color: 'success' });
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to unlink GitHub', color: 'error' });
		} finally {
			unlinking = false;
		}
	}

	async function checkTailscaleStatus() {
		tailscaleLoading = true;
		try {
			const response = await apiFetch('/apiv1/tailscale/status');
			if (response.ok) {
				const data = await response.json();
				tailscaleLinked = data.linked;
				tailscaleTailnet = data.tailnet || null;
			}
		} catch (e) {
			console.error('Failed to check Tailscale status:', e);
		} finally {
			tailscaleLoading = false;
		}
	}

	async function linkTailscale() {
		if (!tailscaleApiKey.trim()) return;
		linkingTailscale = true;
		try {
			const response = await apiFetch('/apiv1/tailscale/link', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ apiKey: tailscaleApiKey.trim() })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to connect Tailscale');
			}
			const data = await response.json();
			tailscaleLinked = true;
			tailscaleTailnet = data.tailnet;
			tailscaleApiKey = '';
			showTailscaleForm = false;
			toasts.add({ title: 'Tailscale Connected', description: `Linked to ${data.tailnet}`, color: 'success' });
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to connect Tailscale', color: 'error' });
		} finally {
			linkingTailscale = false;
		}
	}

	async function unlinkTailscale() {
		unlinkingTailscale = true;
		try {
			const response = await apiFetch('/apiv1/tailscale/unlink', { method: 'DELETE' });
			if (!response.ok) throw new Error('Failed to unlink Tailscale account');
			tailscaleLinked = false;
			tailscaleTailnet = null;
			toasts.add({ title: 'Tailscale Disconnected', description: 'Your Tailscale account has been disconnected', color: 'success' });
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to unlink Tailscale', color: 'error' });
		} finally {
			unlinkingTailscale = false;
		}
	}

	async function fetchSessions() {
		sessionsLoading = true;
		sessionsError = null;
		try {
			const response = await apiFetch('/apiv1/auth/sessions');
			if (!response.ok) throw new Error('Failed to load sessions');
			const data = await response.json();
			sessions = data.sessions ?? [];
		} catch (err) {
			sessionsError = err instanceof Error ? err.message : 'Could not load sessions';
		} finally {
			sessionsLoading = false;
		}
	}

	function confirmRevokeSession(session: SessionRecord) {
		sessionToRevoke = session;
		showRevokeSessionModal = true;
	}

	async function revokeSession(session: SessionRecord) {
		if (revokingSessionId) return;
		revokingSessionId = session.id;
		try {
			const response = await apiFetch(`/apiv1/auth/sessions/${session.id}`, { method: 'DELETE' });
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data?.message || 'Failed to revoke session');
			}
			toasts.add({ title: 'Session revoked', color: 'success' });
			await fetchSessions();
		} catch (err) {
			toasts.add({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to revoke session', color: 'error' });
		} finally {
			revokingSessionId = null;
		}
	}

	async function revokeAllSessions() {
		if (revokingAll) return;
		revokingAll = true;
		try {
			const response = await apiFetch('/apiv1/auth/sessions/revoke-all', { method: 'POST' });
			if (!response.ok) throw new Error('Failed to revoke sessions');
			const data = await response.json();
			toasts.add({ title: 'Sessions revoked', description: `${data.revokedCount} session${data.revokedCount === 1 ? '' : 's'} signed out`, color: 'success' });
			await fetchSessions();
		} catch (err) {
			toasts.add({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to revoke sessions', color: 'error' });
		} finally {
			revokingAll = false;
			showRevokeAllModal = false;
		}
	}

	function getDeviceIcon(deviceName?: string | null): 'monitor' | 'smartphone' {
		if (!deviceName) return 'monitor';
		const lower = deviceName.toLowerCase();
		if (lower.includes('iphone') || lower.includes('android') || lower.includes('mobile') || lower.includes('ipad')) return 'smartphone';
		return 'monitor';
	}

	function formatRelativeTime(dateStr: string): string {
		const now = Date.now();
		const date = new Date(dateStr).getTime();
		const diffMs = now - date;
		const diffMin = Math.floor(diffMs / 60000);
		if (diffMin < 1) return 'Just now';
		if (diffMin < 60) return `${diffMin}m ago`;
		const diffHr = Math.floor(diffMin / 60);
		if (diffHr < 24) return `${diffHr}h ago`;
		const diffDay = Math.floor(diffHr / 24);
		if (diffDay < 7) return `${diffDay}d ago`;
		return new Date(dateStr).toLocaleDateString(undefined, { dateStyle: 'medium' });
	}

	onMount(() => {
		if (browser && typeof window !== 'undefined' && !window.isSecureContext) {
			passkeyEnvWarning = `Passkeys require a secure origin. You're on ${window.location.origin}.`;
		}
		checkGitHubStatus();
		checkTailscaleStatus();
		fetchPasskeys();
		fetchSessions();

		// Scroll to #invitations if hash is present
		if (browser && window.location.hash === '#invitations') {
			requestAnimationFrame(() => {
				document.getElementById('invitations')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			});
		}
	});

	async function fetchPasskeys() {
		passkeysLoading = true;
		passkeyListError = null;
		try {
			const response = await apiFetch('/apiv1/auth/passkeys');
			if (!response.ok) throw new Error('Failed to load passkeys');
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
		if (!browser || typeof window === 'undefined') { toasts.add({ title: 'Unsupported', description: 'Passkeys are not available in this environment.', color: 'error' }); return; }
		if (!window.isSecureContext) { toasts.add({ title: 'Use a secure origin', description: 'Passkeys require https:// or http://localhost.', color: 'error' }); return; }
		if (!window.PublicKeyCredential) { toasts.add({ title: 'Unsupported', description: 'Passkeys are not available on this device.', color: 'error' }); return; }

		registerLoading = true;
		try {
			const optionsResponse = await apiFetch('/apiv1/auth/passkey/register/options', { method: 'POST' });
			if (!optionsResponse.ok) throw new Error('Could not create passkey challenge');
			const options = await optionsResponse.json();
			const { startRegistration } = await import('@simplewebauthn/browser');
			const credential = await startRegistration({ optionsJSON: options });
			const verifyResponse = await apiFetch('/apiv1/auth/passkey/register/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ response: credential, friendlyName: newPasskeyName.trim() || undefined })
			});
			if (!verifyResponse.ok) {
				const data = await verifyResponse.json().catch(() => ({}));
				throw new Error(data?.message || 'Passkey registration failed');
			}
			toasts.add({ title: 'Passkey added', description: 'You can now sign in with this device.', color: 'success' });
			newPasskeyName = '';
			showAddPasskey = false;
			await fetchPasskeys();
		} catch (err) {
			const description = err instanceof Error ? (err.name === 'NotAllowedError' ? 'Passkey prompt was cancelled.' : err.message) : 'Failed to register passkey.';
			toasts.add({ title: 'Unable to register passkey', description, color: 'error' });
		} finally {
			registerLoading = false;
		}
	}

	function startRenaming(passkey: PasskeyRecord) { editingPasskeyId = passkey.id; renameValue = passkey.friendlyName || ''; }
	function cancelRenaming() { editingPasskeyId = null; renameValue = ''; }

	async function savePasskeyName() {
		if (!editingPasskeyId) return;
		const friendlyName = renameValue.trim();
		if (!friendlyName) { toasts.add({ title: 'Name required', description: 'Give this passkey a short name.', color: 'error' }); return; }
		renaming = true;
		try {
			const response = await apiFetch(`/apiv1/auth/passkeys/${editingPasskeyId}/rename`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ friendlyName })
			});
			if (!response.ok) throw new Error('Failed to rename passkey');
			toasts.add({ title: 'Passkey renamed', color: 'success' });
			cancelRenaming();
			await fetchPasskeys();
		} catch (err) {
			toasts.add({ title: 'Rename failed', description: err instanceof Error ? err.message : 'Could not update name', color: 'error' });
		} finally {
			renaming = false;
		}
	}

	function confirmDeletePasskey(passkey: PasskeyRecord) { passkeyToDelete = passkey; showDeletePasskeyModal = true; }

	async function deletePasskey(passkey: PasskeyRecord) {
		if (deletingPasskeyId) return;
		deletingPasskeyId = passkey.id;
		try {
			const response = await apiFetch(`/apiv1/auth/passkeys/${passkey.id}`, { method: 'DELETE' });
			if (!response.ok) throw new Error('Failed to delete passkey');
			toasts.add({ title: 'Passkey removed', color: 'success' });
			if (editingPasskeyId === passkey.id) cancelRenaming();
			await fetchPasskeys();
		} catch (err) {
			toasts.add({ title: 'Unable to remove passkey', description: err instanceof Error ? err.message : 'Something went wrong', color: 'error' });
		} finally {
			deletingPasskeyId = null;
		}
	}

	function formatTimestamp(value?: string | null) {
		if (!value) return 'Never';
		return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	}
</script>

<div class="us-page">
	<div class="us-grid-fade"></div>

	<div class="us-content">
		<button onclick={() => window.history.back()} class="us-back">
			<ArrowLeft class="h-3.5 w-3.5" />
			Back
		</button>

		<!-- Single card for everything -->
		<div class="us-card">
			<!-- Profile -->
			<input
				bind:this={avatarInput}
				type="file"
				accept="image/jpeg,image/png,image/gif,image/webp"
				class="us-hidden-input"
				onchange={uploadAvatar}
			/>
			<div class="us-identity">
				<div class="us-avatar-wrapper">
					<div class="us-avatar">
						{#if $user?.imageUrl}
							<img src={$user.imageUrl} alt={$user.name || 'User'} class="us-avatar-img" />
						{:else}
							<span class="us-avatar-letter">
								{$user?.firstName?.[0] || $user?.name?.[0] || 'U'}
							</span>
						{/if}
					</div>
					<div class="us-avatar-actions">
						<button
							class="us-avatar-btn"
							onclick={() => avatarInput?.click()}
							disabled={uploadingAvatar}
							title="Upload photo"
						>
							{#if uploadingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Camera class="h-3 w-3" />{/if}
						</button>
						{#if $user?.imageUrl}
							<button
								class="us-avatar-btn us-avatar-btn--danger"
								onclick={deleteAvatar}
								disabled={deletingAvatar}
								title="Remove photo"
							>
								{#if deletingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<X class="h-3 w-3" />{/if}
							</button>
						{/if}
					</div>
				</div>
				<div class="us-identity-text">
					<h1 class="us-name">
						{#if $user?.firstName || $user?.lastName}
							{$user?.firstName || ''} {$user?.lastName || ''}
						{:else}
							{$user?.name || $user?.username || 'User'}
						{/if}
					</h1>
					<p class="us-email">
						{displayEmail}
						<button
							class="us-reveal"
							onclick={() => emailRevealed = !emailRevealed}
							aria-label={emailRevealed ? 'Hide email' : 'Show email'}
						>
							{#if emailRevealed}<EyeOff class="h-3 w-3" />{:else}<Eye class="h-3 w-3" />{/if}
						</button>
					</p>
				</div>
			</div>

			<div class="us-card-divider"></div>

			<!-- Inline-editable fields in columns -->
			<div class="us-fields-grid">
				{#each [
					{ key: 'firstName', label: 'First name', value: $user?.firstName || '—', mono: false },
					{ key: 'lastName', label: 'Last name', value: $user?.lastName || '—', mono: false },
					{ key: 'username', label: 'Username', value: $user?.username || '—', mono: true }
				] as field}
					<div class="us-field-cell" class:us-field-cell--editing={editingField === field.key}>
						<span class="us-label">{field.label}</span>
						{#if editingField === field.key}
							<div class="us-inline-edit">
								<input
									class="us-inline-input"
									class:us-inline-input--mono={field.mono}
									type="text"
									bind:value={editValue}
									onkeydown={handleFieldKeydown}
									autofocus
								/>
								<div class="us-inline-btns">
									<button class="us-inline-btn us-inline-btn--save" onclick={saveField} disabled={savingField}>
										{#if savingField}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Check class="h-3 w-3" />{/if}
									</button>
									<button class="us-inline-btn" onclick={cancelEditField}><X class="h-3 w-3" /></button>
								</div>
							</div>
						{:else}
							<div class="us-field-value-row">
								<span class="us-value" class:us-value--mono={field.mono}>{field.value}</span>
								<button class="us-field-edit" onclick={() => startEditField(field.key)}>
									<Pencil class="h-3 w-3" />
								</button>
							</div>
						{/if}
					</div>
				{/each}
			</div>

			{#if invitations.length > 0}
				<div class="us-card-divider"></div>

				<!-- Invitations -->
				<div class="us-card-section" id="invitations">
					<div class="us-section-head">
						<div class="us-section-icon us-section-icon--invitations">
							<Mail class="h-4 w-4" />
						</div>
						<div class="us-section-title-group">
							<h2 class="us-section-title">Pending Invitations</h2>
							<p class="us-section-desc">{invitations.length} organization{invitations.length === 1 ? '' : 's'} invited you</p>
						</div>
						<span class="us-count">{invitations.length}</span>
					</div>

					<div class="us-invitations-list">
						{#each invitations as invitation (invitation.id)}
							<div class="us-invitation">
								<div class="us-invitation-icon">
									{#if invitation.organization.avatarUrl}
										<img src={invitation.organization.avatarUrl} alt={invitation.organization.name} class="us-invitation-avatar" />
									{:else}
										<Building2 class="h-5 w-5" />
									{/if}
								</div>
								<div class="us-invitation-body">
									<span class="us-invitation-name">{invitation.organization.name}</span>
									<span class="us-invitation-meta">
										Invited by {pendingInvitations.getInviterName(invitation.inviter)} · {invitation.role}
									</span>
								</div>
								<div class="us-invitation-actions">
									<button
										class="us-btn us-btn-ghost"
										onclick={() => handleDeclineInvitation(invitation)}
										disabled={acceptingInvitation !== null || decliningInvitation !== null}
									>
										{#if decliningInvitation === invitation.token}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
										Decline
									</button>
									<button
										class="us-btn us-btn-solid"
										onclick={() => handleAcceptInvitation(invitation)}
										disabled={acceptingInvitation !== null || decliningInvitation !== null}
									>
										{#if acceptingInvitation === invitation.token}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
										Accept
									</button>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<div class="us-card-divider"></div>

			<!-- GitHub Account -->
			<div class="us-card-section">
				<div class="us-section-head">
					<div class="us-section-icon us-section-icon--github">
						<Github class="h-4 w-4" />
					</div>
					<div class="us-section-title-group">
						<h2 class="us-section-title">GitHub Account</h2>
						<p class="us-section-desc">Required to deploy from GitHub. We sign you in with GitHub to verify which repositories you can access — you can only deploy repos visible to your account.</p>
					</div>
					{#if !loading}
						<div class="us-pill" class:us-pill--active={githubLinked}>
							<span class="us-pill-dot"></span>
							{githubLinked ? 'Connected' : 'Not connected'}
						</div>
					{/if}
				</div>

				{#if loading}
					<div class="us-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
				{:else if githubLinked}
					<div class="us-integration-row">
						<div class="us-gh-badge">
							<Github class="h-4 w-4" />
							<span class="us-gh-name">@{githubUsername}</span>
						</div>
						<button onclick={unlinkGitHub} disabled={unlinking} class="us-btn us-btn-danger">
							{#if unlinking}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Unlink class="h-3.5 w-3.5" />{/if}
							Disconnect
						</button>
					</div>
				{:else}
					<button onclick={linkGitHub} class="us-connect-btn">
						<div class="us-connect-icon">
							<Github class="h-5 w-5" />
						</div>
						<div class="us-connect-text">
							<span class="us-connect-label">Sign in with GitHub</span>
							<span class="us-connect-hint">Required to deploy. Used to check which repos you can access — no extra scopes requested.</span>
						</div>
						<ChevronRight class="h-4 w-4 us-connect-arrow" />
					</button>
				{/if}
			</div>

			<div class="us-card-divider"></div>

			<!-- GitHub App (Repo Access) -->
			<div class="us-card-section">
				<div class="us-section-head">
					<div class="us-section-icon us-section-icon--github">
						<Github class="h-4 w-4" />
					</div>
					<div class="us-section-title-group">
						<h2 class="us-section-title">GitHub App</h2>
						<p class="us-section-desc">Grant access to specific repos and orgs for deployments</p>
					</div>
					{#if !loading}
						<div class="us-pill" class:us-pill--active={githubInstallations.length > 0}>
							<span class="us-pill-dot"></span>
							{githubInstallations.length > 0 ? `${githubInstallations.length} installed` : 'Not installed'}
						</div>
					{/if}
				</div>

				{#if loading}
					<div class="us-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
				{:else}
					{#if githubInstallations.length > 0}
						<div style="display: flex; flex-direction: column; gap: 0.5rem;">
							{#each githubInstallations as inst}
								<div class="us-integration-row">
									<div class="us-gh-badge">
										<Github class="h-4 w-4" />
										<span class="us-gh-name">{inst.accountLogin}</span>
										<span style="font-size: 0.7rem; color: var(--text-secondary); opacity: 0.7;">
											{inst.repositorySelection === 'all' ? 'All repos' : 'Selected repos'}
										</span>
									</div>
								</div>
							{/each}
						</div>
					{/if}
					{#if githubAppInstallUrl}
						<a href={githubAppInstallUrl} target="_blank" class="us-connect-btn" style="margin-top: {githubInstallations.length > 0 ? '0.5rem' : '0'}; text-decoration: none;">
							<div class="us-connect-icon">
								<Plus class="h-5 w-5" />
							</div>
							<div class="us-connect-text">
								<span class="us-connect-label">{githubInstallations.length > 0 ? 'Add another org/account' : 'Install GitHub App'}</span>
								<span class="us-connect-hint">Choose exactly which repositories and organizations to grant access to</span>
							</div>
							<ChevronRight class="h-4 w-4 us-connect-arrow" />
						</a>
					{/if}
				{/if}
			</div>

			<div class="us-card-divider"></div>

			<!-- Tailscale -->
			<div class="us-card-section">
				<div class="us-section-head">
					<div class="us-section-icon us-section-icon--tailscale">
						<Globe class="h-4 w-4" />
					</div>
					<div class="us-section-title-group">
						<h2 class="us-section-title">Tailscale</h2>
						<p class="us-section-desc">Access your deployments on your private network</p>
					</div>
					{#if !tailscaleLoading}
						<div class="us-pill" class:us-pill--active={tailscaleLinked}>
							<span class="us-pill-dot"></span>
							{tailscaleLinked ? 'Connected' : 'Not connected'}
						</div>
					{/if}
				</div>

				{#if tailscaleLoading}
					<div class="us-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
				{:else if tailscaleLinked}
					<div class="us-integration-row">
						<div class="us-gh-badge">
							<Globe class="h-4 w-4" />
							<span class="us-gh-name">{tailscaleTailnet}</span>
						</div>
						<button onclick={unlinkTailscale} disabled={unlinkingTailscale} class="us-btn us-btn-danger">
							{#if unlinkingTailscale}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Unlink class="h-3.5 w-3.5" />{/if}
							Disconnect
						</button>
					</div>
				{:else if showTailscaleForm}
					<div class="space-y-3">
						<div class="space-y-1.5">
							<p class="text-xs" style="color: var(--surface-muted);">
								Paste a Tailscale auth key below. To create one:
							</p>
							<ol class="text-xs space-y-1 pl-4" style="color: var(--surface-muted); list-style: decimal;">
								<li>Go to <a href="https://login.tailscale.com/admin/settings/keys" target="_blank" rel="noopener" class="underline" style="color: var(--button-bg);">Tailscale Admin → Settings → Keys</a></li>
								<li>Click <strong>Generate auth key</strong></li>
								<li>Enable <strong>Reusable</strong> so it can be used for multiple deployments</li>
								<li>Set expiration to <strong>90 days</strong> (max)</li>
								<li>Enable <strong>Ephemeral</strong> so nodes auto-remove when deployments stop</li>
								<li>Leave <strong>Tags</strong> empty</li>
								<li>Click <strong>Generate key</strong>, copy it, and paste it here</li>
							</ol>
						</div>
						<div class="flex items-center gap-2">
							<input
								type="password"
								class="input text-sm flex-1"
								placeholder="tskey-auth-..."
								bind:value={tailscaleApiKey}
								onkeydown={(e) => { if (e.key === 'Enter') linkTailscale(); }}
							/>
							<button onclick={() => { showTailscaleForm = false; tailscaleApiKey = ''; }} class="btn btn-secondary btn-sm">Cancel</button>
							<button onclick={linkTailscale} disabled={linkingTailscale || !tailscaleApiKey.trim()} class="btn btn-primary btn-sm">
								{#if linkingTailscale}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
								Connect
							</button>
						</div>
					</div>
				{:else}
					<button onclick={() => (showTailscaleForm = true)} class="us-connect-btn">
						<div class="us-connect-icon us-section-icon--tailscale">
							<Globe class="h-5 w-5" />
						</div>
						<div class="us-connect-text">
							<span class="us-connect-label">Connect Tailscale</span>
							<span class="us-connect-hint">Expose deployments directly to your Tailscale network</span>
						</div>
						<ChevronRight class="h-4 w-4 us-connect-arrow" />
					</button>
				{/if}
			</div>

			<div class="us-card-divider"></div>

			<!-- Passkeys -->
			<div class="us-card-section">
				<div class="us-section-head">
					<div class="us-section-icon us-section-icon--passkey">
						<Fingerprint class="h-4 w-4" />
					</div>
					<div class="us-section-title-group">
						<h2 class="us-section-title">Passkeys</h2>
						<p class="us-section-desc">Sign in with Touch ID, Face ID, or Windows Hello</p>
					</div>
					{#if !passkeysLoading && passkeys.length > 0}
						<span class="us-count">{passkeys.length}</span>
					{/if}
				</div>

				{#if passkeyEnvWarning}
					<div class="us-warning">{passkeyEnvWarning}</div>
				{/if}

				{#if passkeyListError}
					<div class="us-error">{passkeyListError}</div>
				{/if}

				{#if passkeysLoading}
					<div class="us-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
				{:else}
					{#if passkeys.length > 0}
						<div class="us-passkey-list">
							{#each passkeys as passkey}
								<div class="us-passkey">
									<div class="us-passkey-dot"></div>
									<div class="us-passkey-body">
										{#if editingPasskeyId === passkey.id}
											<div class="us-passkey-edit-row">
												<input class="us-inline-input us-inline-input--sm" type="text" placeholder="Friendly name" bind:value={renameValue} />
												<button class="us-inline-btn us-inline-btn--save" type="button" onclick={savePasskeyName} disabled={renaming}>
													{#if renaming}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Check class="h-3 w-3" />{/if}
												</button>
												<button class="us-inline-btn" type="button" onclick={cancelRenaming}><X class="h-3 w-3" /></button>
											</div>
										{:else}
											<span class="us-passkey-name">{passkey.friendlyName || 'Passkey'}</span>
											<span class="us-passkey-meta">
												Last used {formatTimestamp(passkey.lastUsedAt)} · Added {formatTimestamp(passkey.createdAt)}
											</span>
										{/if}
									</div>
									{#if editingPasskeyId !== passkey.id}
										<div class="us-passkey-actions">
											<button class="us-icon-btn" type="button" onclick={() => startRenaming(passkey)} title="Rename">
												<Pencil class="h-3 w-3" />
											</button>
											<button class="us-icon-btn us-icon-btn--danger" type="button" onclick={() => confirmDeletePasskey(passkey)} disabled={deletingPasskeyId === passkey.id} title="Remove">
												{#if deletingPasskeyId === passkey.id}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Trash2 class="h-3 w-3" />{/if}
											</button>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{:else}
						<p class="us-empty-hint">No passkeys yet. Add one to skip email codes when signing in.</p>
					{/if}

					{#if showAddPasskey}
						<div class="us-add-passkey-row">
							<input class="us-inline-input" type="text" placeholder="Device name (optional)" bind:value={newPasskeyName} />
							<button class="us-btn us-btn-solid" type="button" onclick={registerPasskey} disabled={registerLoading}>
								{#if registerLoading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
								Register
							</button>
							<button class="us-btn us-btn-ghost" type="button" onclick={() => { showAddPasskey = false; newPasskeyName = ''; }}>Cancel</button>
						</div>
					{:else}
						<button class="us-add-btn" onclick={() => (showAddPasskey = true)}>
							<Plus class="h-3.5 w-3.5" />
							Add passkey
						</button>
					{/if}
				{/if}
			</div>
			<div class="us-card-divider"></div>

			<!-- Sessions -->
			<div class="us-card-section">
				<div class="us-section-head">
					<div class="us-section-icon us-section-icon--sessions">
						<Globe class="h-4 w-4" />
					</div>
					<div class="us-section-title-group">
						<h2 class="us-section-title">Active Sessions</h2>
						<p class="us-section-desc">Devices where you're currently signed in</p>
					</div>
					{#if !sessionsLoading && sessions.length > 0}
						<span class="us-count">{sessions.length}</span>
					{/if}
				</div>

				{#if sessionsError}
					<div class="us-error">{sessionsError}</div>
				{/if}

				{#if sessionsLoading}
					<div class="us-loading"><Loader2 class="h-4 w-4 animate-spin" /></div>
				{:else}
					{#if sessions.length > 0}
						<div class="us-session-list">
							{#each sessions as session (session.id)}
								<div class="us-session" class:us-session--current={session.isCurrent}>
									<div class="us-session-icon">
										{#if getDeviceIcon(session.deviceName) === 'smartphone'}
											<Smartphone class="h-4 w-4" />
										{:else}
											<Monitor class="h-4 w-4" />
										{/if}
									</div>
									<div class="us-session-body">
										<div class="us-session-top">
											<span class="us-session-device">
												{session.deviceName || 'Unknown Device'}
												{#if session.isCurrent}
													<span class="us-session-current-badge">This device</span>
												{/if}
											</span>
										</div>
										<div class="us-session-meta">
											{#if session.location}
												<span>{session.location}</span>
												<span class="us-session-sep">·</span>
											{/if}
											{#if session.ipAddress}
												<span>{session.ipAddress}</span>
												<span class="us-session-sep">·</span>
											{/if}
											<span>Active {formatRelativeTime(session.lastActiveAt)}</span>
										</div>
									</div>
									{#if !session.isCurrent}
										<button
											class="us-icon-btn us-icon-btn--danger"
											type="button"
											onclick={() => confirmRevokeSession(session)}
											disabled={revokingSessionId === session.id}
											title="Sign out this device"
										>
											{#if revokingSessionId === session.id}
												<Loader2 class="h-3 w-3 animate-spin" />
											{:else}
												<LogOut class="h-3 w-3" />
											{/if}
										</button>
									{/if}
								</div>
							{/each}
						</div>

						{#if sessions.length > 1}
							<button class="us-btn us-btn-danger us-btn--full" onclick={() => (showRevokeAllModal = true)}>
								<LogOut class="h-3.5 w-3.5" />
								Sign out all other devices
							</button>
						{/if}
					{:else}
						<p class="us-empty-hint">No active sessions found.</p>
					{/if}
				{/if}
			</div>
		</div>
	</div>
</div>

{#if sessionToRevoke}
	<ConfirmModal
		bind:open={showRevokeSessionModal}
		title="Sign out this device?"
		description="This will immediately end the session on {sessionToRevoke.deviceName || 'this device'}. They will need to sign in again."
		confirmLabel="Sign Out"
		danger
		onconfirm={() => revokeSession(sessionToRevoke!)}
		oncancel={() => { sessionToRevoke = null; }}
	/>
{/if}

<ConfirmModal
	bind:open={showRevokeAllModal}
	title="Sign out all other devices?"
	description="This will end all sessions except your current one. Other devices will need to sign in again."
	confirmLabel="Sign Out All"
	danger
	onconfirm={revokeAllSessions}
	oncancel={() => { showRevokeAllModal = false; }}
/>

{#if passkeyToDelete}
	<ConfirmModal
		bind:open={showDeletePasskeyModal}
		title='Remove "{passkeyToDelete.friendlyName || "this passkey"}"?'
		description="This passkey will be permanently removed. You will no longer be able to use it to sign in."
		confirmLabel="Remove Passkey"
		danger
		onconfirm={() => deletePasskey(passkeyToDelete!)}
		oncancel={() => { passkeyToDelete = null; }}
	/>
{/if}

<style>
	/* ── Page ── */
	.us-page {
		position: relative;
		min-height: 100%;
		overflow-y: auto;
	}

	.us-grid-fade {
		position: fixed;
		inset: 0;
		pointer-events: none;
		z-index: 0;
		background-image:
			linear-gradient(color-mix(in srgb, var(--surface-border) 50%, transparent) 1px, transparent 1px),
			linear-gradient(90deg, color-mix(in srgb, var(--surface-border) 50%, transparent) 1px, transparent 1px);
		background-size: 80px 80px;
		opacity: 0.35;
		mask-image: radial-gradient(ellipse 70% 40% at 50% 0%, black 0%, transparent 100%);
		-webkit-mask-image: radial-gradient(ellipse 70% 40% at 50% 0%, black 0%, transparent 100%);
	}

	.us-content {
		position: relative;
		z-index: 1;
		max-width: 42rem;
		margin: 0 auto;
		padding: 2.5rem 2rem 4rem;
	}

	/* ── Back ── */
	.us-back {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		font-weight: 450;
		color: var(--surface-muted);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
		margin-bottom: 2rem;
		transition: color 120ms;
	}
	.us-back:hover { color: var(--center-channel-color); }

	/* ── Card ── */
	.us-card {
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		background-color: var(--surface-bg);
		overflow: hidden;
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}

	.us-card-divider {
		height: 1px;
		background-color: var(--surface-border);
	}

	.us-hidden-input {
		position: absolute;
		width: 0;
		height: 0;
		opacity: 0;
		pointer-events: none;
	}

	/* ── Identity (inside card) ── */
	.us-identity {
		display: flex;
		align-items: center;
		gap: 1.125rem;
		padding: 1.75rem 2rem;
	}

	.us-avatar {
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 0.875rem;
		overflow: hidden;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: linear-gradient(135deg, color-mix(in srgb, var(--button-bg) 18%, transparent), color-mix(in srgb, var(--button-bg) 6%, transparent));
		color: var(--button-bg);
	}

	.us-avatar-wrapper {
		position: relative;
		flex-shrink: 0;
	}

	.us-avatar-wrapper:hover .us-avatar-actions {
		opacity: 1;
	}

	.us-avatar-actions {
		position: absolute;
		bottom: -0.25rem;
		right: -0.25rem;
		display: flex;
		gap: 0.125rem;
		opacity: 0;
		transition: opacity 150ms;
	}

	.us-avatar-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.375rem;
		height: 1.375rem;
		border-radius: 50%;
		border: 1.5px solid var(--surface-bg);
		background-color: var(--button-bg);
		color: var(--button-color);
		cursor: pointer;
		transition: all 120ms;
		padding: 0;
	}
	.us-avatar-btn:hover:not(:disabled) { opacity: 0.85; }
	.us-avatar-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.us-avatar-btn--danger {
		background-color: var(--error-text-color);
	}

	.us-avatar-img { width: 100%; height: 100%; object-fit: cover; }
	.us-avatar-letter { font-size: 1.25rem; font-weight: 700; }

	.us-identity-text { flex: 1; min-width: 0; }

	.us-name {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--center-channel-color);
		letter-spacing: -0.02em;
		line-height: 1.2;
		margin: 0;
	}

	.us-email {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-top: 0.125rem;
	}

	.us-reveal {
		display: inline-flex;
		align-items: center;
		padding: 0.2rem;
		border-radius: 0.25rem;
		color: var(--surface-muted);
		background: none;
		border: none;
		cursor: pointer;
		transition: color 120ms;
	}
	.us-reveal:hover { color: var(--center-channel-color); }

	/* ── Fields grid (3 columns inside card) ── */
	.us-fields-grid {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		padding: 0;
	}

	.us-field-cell {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 1.25rem 2rem;
		position: relative;
		transition: background-color 120ms;
	}

	.us-field-cell:not(:first-child)::before {
		content: '';
		position: absolute;
		left: 0;
		top: 1.25rem;
		bottom: 1.25rem;
		width: 1px;
		background-color: color-mix(in srgb, var(--surface-border) 60%, transparent);
	}

	.us-field-cell:not(.us-field-cell--editing):hover {
		background-color: color-mix(in srgb, var(--center-channel-color) 2.5%, transparent);
	}

	.us-field-cell:not(.us-field-cell--editing):hover .us-field-edit {
		opacity: 1;
	}

	.us-label {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--surface-muted);
	}

	.us-field-value-row {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-height: 1.625rem;
	}

	.us-value {
		flex: 1;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--center-channel-color);
		min-width: 0;
	}

	.us-value--mono {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		font-weight: 400;
	}

	.us-field-edit {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		opacity: 0;
		transition: all 120ms;
		flex-shrink: 0;
	}

	.us-field-edit:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--center-channel-color) 6%, transparent);
	}

	/* ── Inline edit ── */
	.us-inline-edit {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
	}

	.us-inline-btns {
		display: flex;
		gap: 0.125rem;
	}

	.us-inline-input {
		width: 100%;
		min-width: 0;
		padding: 0.3125rem 0.5rem;
		font-size: 0.875rem;
		border: 1px solid var(--sidebar-text-active-border);
		border-radius: 0.375rem;
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
		transition: border-color 150ms, box-shadow 150ms;
		line-height: 1.5;
	}
	.us-inline-input:focus { outline: none; }
	.us-inline-input::placeholder { color: color-mix(in srgb, var(--surface-muted) 55%, transparent); }
	.us-inline-input--mono { font-family: var(--font-mono); font-size: 0.8125rem; font-weight: 400; }
	.us-inline-input--sm { padding: 0.3125rem 0.5rem; font-size: 0.8125rem; }

	.us-inline-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		flex-shrink: 0;
		transition: all 120ms;
	}
	.us-inline-btn:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--center-channel-color) 6%, transparent);
	}
	.us-inline-btn--save {
		color: var(--button-bg);
	}
	.us-inline-btn--save:hover {
		color: var(--button-bg);
		background-color: color-mix(in srgb, var(--button-bg) 10%, transparent);
	}
	.us-inline-btn:disabled { opacity: 0.4; cursor: not-allowed; }

	/* ── Card section (GitHub, Passkeys inside the card) ── */
	.us-card-section {
		display: flex;
		flex-direction: column;
		gap: 1.125rem;
		padding: 1.5rem 2rem;
	}

	.us-section-head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.us-section-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
	}

	.us-section-icon--github {
		background-color: color-mix(in srgb, var(--center-channel-color) 8%, transparent);
		color: var(--center-channel-color);
	}
	.us-section-icon--passkey {
		background-color: color-mix(in srgb, var(--button-bg) 10%, transparent);
		color: var(--button-bg);
	}
	.us-section-icon--invitations {
		background-color: color-mix(in srgb, var(--sidebar-text-active-border) 10%, transparent);
		color: var(--sidebar-text-active-border);
	}
	.us-section-icon--sessions {
		background-color: color-mix(in srgb, var(--online-indicator) 10%, transparent);
		color: var(--online-indicator);
	}
	.us-section-icon--tailscale {
		background-color: color-mix(in srgb, var(--center-channel-color) 8%, transparent);
		color: var(--center-channel-color);
	}

	/* ── Invitations ── */
	.us-invitations-list {
		display: flex;
		flex-direction: column;
	}

	.us-invitation {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		padding: 0.875rem 1rem;
		border-radius: 0.625rem;
		border: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
		background-color: color-mix(in srgb, var(--center-channel-color) 2%, transparent);
	}

	.us-invitation + .us-invitation {
		margin-top: 0.5rem;
	}

	.us-invitation-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.625rem;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--button-bg) 8%, transparent);
		color: var(--button-bg);
		overflow: hidden;
	}

	.us-invitation-avatar {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.us-invitation-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.us-invitation-name {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--center-channel-color);
	}

	.us-invitation-meta {
		font-size: 0.6875rem;
		color: var(--surface-muted);
	}

	.us-invitation-actions {
		display: flex;
		gap: 0.375rem;
		flex-shrink: 0;
	}

	.us-section-title-group { flex: 1; min-width: 0; }

	.us-section-title {
		font-size: 0.9375rem;
		font-weight: 650;
		color: var(--center-channel-color);
		margin: 0;
		line-height: 1.3;
	}

	.us-section-desc {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0.0625rem 0 0;
	}

	/* ── Pill ── */
	.us-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.1875rem 0.625rem;
		border-radius: 2rem;
		font-size: 0.6875rem;
		font-weight: 550;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--surface-muted) 8%, transparent);
		color: var(--surface-muted);
	}
	.us-pill--active {
		background-color: color-mix(in srgb, var(--online-indicator) 10%, transparent);
		color: var(--online-indicator);
	}
	.us-pill-dot {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 50%;
		background-color: currentColor;
	}

	/* ── Loading ── */
	.us-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem 0;
		color: var(--surface-muted);
	}

	/* ── GitHub connected ── */
	.us-integration-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem 1rem;
		border-radius: 0.625rem;
		border: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
		background-color: color-mix(in srgb, var(--center-channel-color) 2%, transparent);
	}

	.us-gh-badge {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--center-channel-color);
	}

	.us-gh-name {
		font-size: 0.875rem;
		font-weight: 550;
		font-family: var(--font-mono);
	}

	/* ── GitHub connect button ── */
	.us-connect-btn {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		width: 100%;
		padding: 0.875rem 1rem;
		border-radius: 0.75rem;
		border: 1px dashed color-mix(in srgb, var(--surface-border) 80%, transparent);
		background: none;
		cursor: pointer;
		color: var(--center-channel-color);
		text-align: left;
		transition: all 150ms;
	}
	.us-connect-btn:hover {
		border-color: var(--button-bg);
		border-style: solid;
		background-color: color-mix(in srgb, var(--button-bg) 4%, transparent);
	}
	.us-connect-btn:hover .us-connect-arrow {
		color: var(--button-bg);
		transform: translateX(2px);
	}

	.us-connect-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.625rem;
		background-color: color-mix(in srgb, var(--center-channel-color) 7%, transparent);
		color: var(--center-channel-color);
		flex-shrink: 0;
	}
	.us-connect-text { flex: 1; display: flex; flex-direction: column; gap: 0.0625rem; }
	.us-connect-label { font-size: 0.875rem; font-weight: 550; }
	.us-connect-hint { font-size: 0.75rem; color: var(--surface-muted); }
	.us-connect-arrow { color: var(--surface-muted); flex-shrink: 0; transition: all 150ms; }

	/* ── Count ── */
	.us-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.375rem;
		border-radius: 2rem;
		font-size: 0.6875rem;
		font-weight: 650;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--button-bg) 10%, transparent);
		color: var(--button-bg);
	}

	/* ── Buttons ── */
	.us-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 550;
		border: none;
		cursor: pointer;
		transition: all 120ms;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.us-btn:disabled { opacity: 0.5; cursor: not-allowed; }

	.us-btn-solid {
		background-color: var(--button-bg);
		color: var(--button-color);
	}
	.us-btn-solid:hover:not(:disabled) { opacity: 0.9; }

	.us-btn-ghost {
		background: none;
		color: var(--surface-muted);
	}
	.us-btn-ghost:hover:not(:disabled) {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--center-channel-color) 5%, transparent);
	}

	.us-btn-danger {
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
	}
	.us-btn-danger:hover:not(:disabled) {
		background-color: color-mix(in srgb, var(--error-text-color) 16%, transparent);
	}

	/* ── Passkeys ── */
	.us-passkey-list {
		display: flex;
		flex-direction: column;
	}

	.us-passkey {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.875rem 0;
		border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 40%, transparent);
	}
	.us-passkey:last-child { border-bottom: none; }

	.us-passkey-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background-color: var(--button-bg);
		flex-shrink: 0;
		margin-top: 0.4375rem;
		opacity: 0.6;
	}

	.us-passkey-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.us-passkey-name {
		font-size: 0.875rem;
		font-weight: 550;
		color: var(--center-channel-color);
	}

	.us-passkey-meta {
		font-size: 0.6875rem;
		color: var(--surface-muted);
	}

	.us-passkey-edit-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.us-passkey-actions {
		display: flex;
		gap: 0.125rem;
		flex-shrink: 0;
		margin-top: 0.125rem;
	}

	.us-icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		border: none;
		background: none;
		color: var(--surface-muted);
		cursor: pointer;
		transition: all 120ms;
	}
	.us-icon-btn:hover {
		color: var(--center-channel-color);
		background-color: color-mix(in srgb, var(--center-channel-color) 6%, transparent);
	}
	.us-icon-btn--danger:hover {
		color: var(--error-text-color);
		background-color: color-mix(in srgb, var(--error-text-color) 8%, transparent);
	}
	.us-icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }

	/* ── Add passkey ── */
	.us-add-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		font-weight: 550;
		color: var(--button-bg);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0.25rem 0;
		transition: opacity 120ms;
	}
	.us-add-btn:hover { opacity: 0.75; }

	.us-add-passkey-row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	/* ── Sessions ── */
	.us-session-list {
		display: flex;
		flex-direction: column;
	}

	.us-session {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.875rem 0;
		border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 40%, transparent);
	}
	.us-session:last-child { border-bottom: none; }

	.us-session-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--center-channel-color) 6%, transparent);
		color: var(--surface-muted);
	}

	.us-session--current .us-session-icon {
		background-color: color-mix(in srgb, var(--online-indicator) 10%, transparent);
		color: var(--online-indicator);
	}

	.us-session-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.us-session-top {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.us-session-device {
		font-size: 0.875rem;
		font-weight: 550;
		color: var(--center-channel-color);
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.us-session-current-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.0625rem 0.4375rem;
		border-radius: 2rem;
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		background-color: color-mix(in srgb, var(--online-indicator) 12%, transparent);
		color: var(--online-indicator);
	}

	.us-session-meta {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.125rem;
	}

	.us-session-sep {
		margin: 0 0.125rem;
	}

	.us-btn--full {
		width: 100%;
		justify-content: center;
	}

	/* ── Alerts ── */
	.us-empty-hint {
		font-size: 0.8125rem;
		color: var(--surface-muted);
		padding: 0.5rem 0;
	}

	.us-warning {
		padding: 0.625rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		background-color: color-mix(in srgb, var(--warning-text) 8%, transparent);
		color: var(--warning-text);
		border: 1px solid color-mix(in srgb, var(--warning-text) 20%, transparent);
	}

	.us-error {
		padding: 0.625rem 0.875rem;
		border-radius: 0.5rem;
		font-size: 0.8125rem;
		background-color: color-mix(in srgb, var(--error-text-color) 8%, transparent);
		color: var(--error-text-color);
		border: 1px solid color-mix(in srgb, var(--error-text-color) 20%, transparent);
	}

	/* ── Responsive ── */
	@media (max-width: 640px) {
		.us-content { padding: 1.5rem 1rem 3rem; }

		.us-fields-grid { grid-template-columns: 1fr; }

		.us-field-cell:not(:first-child)::before {
			display: none;
		}

		.us-field-cell:not(:first-child) {
			border-top: 1px solid color-mix(in srgb, var(--surface-border) 40%, transparent);
		}

		.us-integration-row { flex-direction: column; align-items: flex-start; }
		.us-add-passkey-row { flex-direction: column; align-items: stretch; }
		.us-invitation { flex-wrap: wrap; }
		.us-invitation-actions { width: 100%; margin-top: 0.25rem; }
	}
</style>
