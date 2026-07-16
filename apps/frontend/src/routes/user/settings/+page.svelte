<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		user,
		apiFetch,
		toasts,
		pendingInvitations,
		organizations,
		type PendingInvitation
	} from '$lib/stores';
	import { ArrowLeft } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import {
		loadEarlyAccessFeatures,
		setEarlyAccessFeatureEnrollment,
		isFeatureEnabledNow,
		featureFlag,
		type EarlyAccessFeature
	} from '$lib/posthog';
	import {
		UserProfile,
		UserInvitations,
		UserGitHub,
		UserTailscale,
		UserPasskeys,
		UserSessions,
		UserEarlyAccess,
		UserAccessibility
	} from '$lib/components/user-settings';

	let githubLinked = $state(false);
	let githubUsername = $state<string | null>(null);
	let loading = $state(true);
	let unlinking = $state(false);
	let githubInstallations = $state<
		Array<{
			id: string;
			installationId: string;
			accountLogin: string;
			accountType: string;
			repositorySelection: string;
		}>
	>([]);
	let githubAppInstallUrl = $state<string | null>(null);
	let githubTokenExpired = $state(false);

	let tailscaleLinked = $state(false);
	let tailscaleTailnet = $state<string | null>(null);
	let tailscaleLoading = $state(true);
	let unlinkingTailscale = $state(false);
	let tailscaleApiKey = $state('');
	let linkingTailscale = $state(false);
	let showTailscaleForm = $state(false);

	interface PasskeyRecord {
		id: string;
		friendlyName?: string | null;
		createdAt: string;
		lastUsedAt?: string | null;
		deviceType?: string | null;
		backedUp?: boolean;
		transports?: string[];
	}
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
	let showAddPasskey = $state(false);
	let showDeletePasskeyModal = $state(false);
	let passkeyToDelete = $state<PasskeyRecord | null>(null);

	let editingField = $state<string | null>(null);
	let editValue = $state('');
	let savingField = $state(false);
	let emailRevealed = $state(false);
	let uploadingAvatar = $state(false);
	let deletingAvatar = $state(false);
	let avatarInput = $state<HTMLInputElement | undefined>(undefined);

	let acceptingInvitation = $state<string | null>(null);
	let decliningInvitation = $state<string | null>(null);
	const invitations = $derived($pendingInvitations);

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

	let earlyAccessFeatures = $state<EarlyAccessFeature[]>([]);
	let earlyAccessLoading = $state(true);
	let earlyAccessEnrollment = $state<Record<string, boolean>>({});
	let togglingFeature = $state<string | null>(null);

	let backendVersion = $state<string | null>(null);
	const frontendVersion = __APP_VERSION__;

	const tailscaleEnabled = featureFlag('tailscale-integration');

	function censorEmail(email: string): string {
		const [local, domain] = email.split('@');
		if (!domain) return '••••••';
		return `${local.slice(0, 2)}${'•'.repeat(Math.max(local.length - 2, 3))}@${domain}`;
	}
	let displayEmail = $derived.by(() => {
		const email = $user?.email || '';
		if (!email) return '';
		return emailRevealed ? email : censorEmail(email);
	});

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
		let trimmed = editValue.trim();
		if (editingField === 'username' && trimmed) {
			trimmed = trimmed.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
			const bad = [...new Set([...trimmed].filter((ch) => !/[a-zA-Z0-9_-]/.test(ch)))];
			if (bad.length) {
				const shown = bad
					.map((ch) =>
						ch.codePointAt(0)! > 126
							? `"${ch}" (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`
							: `"${ch}"`
					)
					.join(', ');
				toasts.add({
					title: 'Invalid username',
					description: `Not allowed: ${shown}. Use letters, numbers, underscores, and hyphens.`,
					color: 'error'
				});
				return;
			}
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
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update',
				color: 'error'
			});
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
			toasts.add({
				title: 'Invalid file type',
				description: 'Only JPEG, PNG, GIF, and WebP images are allowed',
				color: 'error'
			});
			return;
		}
		if (file.size > 5 * 1024 * 1024) {
			toasts.add({
				title: 'File too large',
				description: 'Maximum file size is 5MB',
				color: 'error'
			});
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
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to upload avatar',
				color: 'error'
			});
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
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to remove avatar',
				color: 'error'
			});
		} finally {
			deletingAvatar = false;
		}
	}

	async function handleAcceptInvitation(invitation: PendingInvitation) {
		if (acceptingInvitation || decliningInvitation) return;
		acceptingInvitation = invitation.id;
		try {
			await pendingInvitations.accept(invitation.id, true);
			const orgsResponse = await apiFetch('/apiv1/organizations/user');
			if (orgsResponse.ok) {
				const orgs = await orgsResponse.json();
				organizations.set(orgs);
				organizations.initializeSelected();
			}
			toasts.add({
				title: 'Welcome',
				description: `You've joined ${invitation.organization.name}`,
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to accept invitation',
				color: 'error'
			});
		} finally {
			acceptingInvitation = null;
		}
	}
	async function handleDeclineInvitation(invitation: PendingInvitation) {
		if (acceptingInvitation || decliningInvitation) return;
		decliningInvitation = invitation.id;
		try {
			await pendingInvitations.decline(invitation.id);
			toasts.add({ title: 'Invitation declined', color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to decline invitation',
				color: 'error'
			});
		} finally {
			decliningInvitation = null;
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
				githubTokenExpired = data.tokenExpired ?? false;
			} else {
				console.error('[GitHub status]', response.status, await response.text().catch(() => ''));
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
	function linkGitHub() {
		window.location.href = '/apiv1/github/link';
	}
	async function unlinkGitHub() {
		unlinking = true;
		try {
			const response = await apiFetch('/apiv1/github/unlink', { method: 'DELETE' });
			if (!response.ok) throw new Error('Failed to unlink GitHub account');
			githubLinked = false;
			githubUsername = null;
			toasts.add({
				title: 'GitHub unlinked',
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
			toasts.add({
				title: 'Tailscale connected',
				description: `Linked to ${data.tailnet}`,
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to connect Tailscale',
				color: 'error'
			});
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
			toasts.add({
				title: 'Tailscale disconnected',
				description: 'Your Tailscale account has been disconnected',
				color: 'success'
			});
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to unlink Tailscale',
				color: 'error'
			});
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
			toasts.add({
				title: 'Error',
				description: err instanceof Error ? err.message : 'Failed to revoke session',
				color: 'error'
			});
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
			toasts.add({
				title: 'Sessions revoked',
				description: `${data.revokedCount} session${data.revokedCount === 1 ? '' : 's'} signed out`,
				color: 'success'
			});
			await fetchSessions();
		} catch (err) {
			toasts.add({
				title: 'Error',
				description: err instanceof Error ? err.message : 'Failed to revoke sessions',
				color: 'error'
			});
		} finally {
			revokingAll = false;
			showRevokeAllModal = false;
		}
	}

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
			if (!optionsResponse.ok) throw new Error('Could not create passkey challenge');
			const options = await optionsResponse.json();
			const { startRegistration } = await import('@simplewebauthn/browser');
			const credential = await startRegistration({ optionsJSON: options });
			const verifyResponse = await apiFetch('/apiv1/auth/passkey/register/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
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
			showAddPasskey = false;
			await fetchPasskeys();
		} catch (err) {
			const description =
				err instanceof Error
					? err.name === 'NotAllowedError'
						? 'Passkey prompt was cancelled.'
						: err.message
					: 'Failed to register passkey.';
			toasts.add({ title: 'Unable to register passkey', description, color: 'error' });
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
				description: 'Give this passkey a short name.',
				color: 'error'
			});
			return;
		}
		renaming = true;
		try {
			const response = await apiFetch(`/apiv1/auth/passkeys/${editingPasskeyId}/rename`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ friendlyName })
			});
			if (!response.ok) throw new Error('Failed to rename passkey');
			toasts.add({ title: 'Passkey renamed', color: 'success' });
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
	function confirmDeletePasskey(passkey: PasskeyRecord) {
		passkeyToDelete = passkey;
		showDeletePasskeyModal = true;
	}
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
		if (!value) return 'Never';
		return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	}

	async function fetchEarlyAccessFeatures() {
		earlyAccessLoading = true;
		try {
			const features = await loadEarlyAccessFeatures();
			earlyAccessFeatures = features;
			const next: Record<string, boolean> = {};
			for (const f of features) next[f.flagKey] = isFeatureEnabledNow(f.flagKey);
			earlyAccessEnrollment = next;
		} finally {
			earlyAccessLoading = false;
		}
	}
	async function toggleEarlyAccessFeature(feature: EarlyAccessFeature) {
		if (togglingFeature) return;
		togglingFeature = feature.flagKey;
		const next = !earlyAccessEnrollment[feature.flagKey];
		earlyAccessEnrollment = { ...earlyAccessEnrollment, [feature.flagKey]: next };
		try {
			setEarlyAccessFeatureEnrollment(feature.flagKey, next);
			toasts.add({
				title: next ? 'Enrolled' : 'Unenrolled',
				description: `${next ? 'Enrolled in' : 'Left'} "${feature.name}"`,
				color: 'success'
			});
		} catch (err) {
			earlyAccessEnrollment = { ...earlyAccessEnrollment, [feature.flagKey]: !next };
			toasts.add({
				title: 'Error',
				description: err instanceof Error ? err.message : 'Failed to update enrollment',
				color: 'error'
			});
		} finally {
			togglingFeature = null;
		}
	}

	onMount(() => {
		if (browser && typeof window !== 'undefined' && !window.isSecureContext) {
			passkeyEnvWarning = `Passkeys require a secure origin. You're on ${window.location.origin}.`;
		}

		if (browser) {
			const params = new URLSearchParams(window.location.search);
			const ghError = params.get('error');
			const ghLinked = params.get('github');
			if (ghError) {
				toasts.add({ title: 'GitHub linking failed', description: ghError, color: 'error' });
				console.error('[GitHub OAuth]', ghError);
			} else if (ghLinked === 'linked') {
				toasts.add({
					title: 'GitHub linked',
					description: 'Your GitHub account has been connected',
					color: 'success'
				});
			}
			if (ghError || ghLinked) {
				const url = new URL(window.location.href);
				url.searchParams.delete('error');
				url.searchParams.delete('github');
				goto(url, { replaceState: true, keepFocus: true, noScroll: true });
			}
		}

		checkGitHubStatus();
		if (isFeatureEnabledNow('tailscale-integration')) checkTailscaleStatus();
		fetchPasskeys();
		fetchSessions();
		fetchEarlyAccessFeatures();
		apiFetch('/apiv1/health')
			.then((r) => r.json())
			.then((d) => (backendVersion = d.version))
			.catch(() => {});
		if (browser && window.location.hash === '#invitations') {
			requestAnimationFrame(() => {
				document
					.getElementById('invitations')
					?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			});
		}
	});
</script>

<div class="us-page">
	<div class="us-grid-fade"></div>
	<div class="us-content">
		<button onclick={() => window.history.back()} class="us-back"
			><ArrowLeft class="h-3.5 w-3.5" /> Back</button
		>

		<div class="us-stack">
			<UserProfile
				index={0}
				user={$user}
				{displayEmail}
				bind:emailRevealed
				bind:editingField
				bind:editValue
				{savingField}
				{uploadingAvatar}
				{deletingAvatar}
				onStartEditField={startEditField}
				onCancelEditField={cancelEditField}
				onSaveField={saveField}
				onFieldKeydown={handleFieldKeydown}
				onUploadAvatar={uploadAvatar}
				onDeleteAvatar={deleteAvatar}
				bind:avatarInputRef={avatarInput}
			/>

			<UserInvitations
				index={1}
				{invitations}
				{acceptingInvitation}
				{decliningInvitation}
				onAccept={handleAcceptInvitation}
				onDecline={handleDeclineInvitation}
			/>

			<UserGitHub
				index={2}
				{loading}
				{githubLinked}
				{githubUsername}
				{githubInstallations}
				{githubAppInstallUrl}
				{githubTokenExpired}
				{unlinking}
				onLink={linkGitHub}
				onUnlink={unlinkGitHub}
			/>

			{#if $tailscaleEnabled}
				<UserTailscale
					index={3}
					{tailscaleLoading}
					{tailscaleLinked}
					{tailscaleTailnet}
					{unlinkingTailscale}
					bind:showTailscaleForm
					bind:tailscaleApiKey
					{linkingTailscale}
					onLink={linkTailscale}
					onUnlink={unlinkTailscale}
				/>
			{/if}

			<UserPasskeys
				index={4}
				{passkeys}
				{passkeysLoading}
				{passkeyListError}
				{passkeyEnvWarning}
				{registerLoading}
				bind:showAddPasskey
				bind:newPasskeyName
				bind:editingPasskeyId
				bind:renameValue
				{renaming}
				{deletingPasskeyId}
				onRegister={registerPasskey}
				onStartRenaming={startRenaming}
				onCancelRenaming={cancelRenaming}
				onSavePasskeyName={savePasskeyName}
				onConfirmDelete={confirmDeletePasskey}
				{formatTimestamp}
			/>

			<UserSessions
				index={5}
				{sessions}
				{sessionsLoading}
				{sessionsError}
				{revokingSessionId}
				onConfirmRevokeSession={confirmRevokeSession}
				onShowRevokeAll={() => (showRevokeAllModal = true)}
			/>

			<UserAccessibility index={6} />

			<UserEarlyAccess
				index={7}
				{earlyAccessFeatures}
				{earlyAccessLoading}
				{earlyAccessEnrollment}
				{togglingFeature}
				onToggleFeature={toggleEarlyAccessFeature}
			/>
		</div>

		<p class="us-version">
			{frontendVersion}{backendVersion ? `+${backendVersion}` : ''}
		</p>
	</div>
</div>

{#if sessionToRevoke}
	<ConfirmModal
		bind:open={showRevokeSessionModal}
		title="Sign out this device?"
		description="This will immediately end the session on {sessionToRevoke.deviceName ||
			'this device'}. They will need to sign in again."
		confirmLabel="Sign out"
		danger
		onconfirm={() => revokeSession(sessionToRevoke!)}
		oncancel={() => {
			sessionToRevoke = null;
		}}
	/>
{/if}
<ConfirmModal
	bind:open={showRevokeAllModal}
	title="Sign out all other devices?"
	description="This will end all sessions except your current one. Other devices will need to sign in again."
	confirmLabel="Sign out all"
	danger
	onconfirm={revokeAllSessions}
	oncancel={() => {
		showRevokeAllModal = false;
	}}
/>
{#if passkeyToDelete}
	<ConfirmModal
		bind:open={showDeletePasskeyModal}
		title={`Remove "${passkeyToDelete.friendlyName || 'this passkey'}"?`}
		description="This passkey will be permanently removed. You will no longer be able to use it to sign in."
		confirmLabel="Remove passkey"
		danger
		onconfirm={() => deletePasskey(passkeyToDelete!)}
		oncancel={() => {
			passkeyToDelete = null;
		}}
	/>
{/if}

<style>
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
			linear-gradient(
				color-mix(in srgb, var(--surface-border) 50%, transparent) 1px,
				transparent 1px
			),
			linear-gradient(
				90deg,
				color-mix(in srgb, var(--surface-border) 50%, transparent) 1px,
				transparent 1px
			);
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
	.us-back:hover {
		color: var(--center-channel-color);
	}
	.us-stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.us-version {
		text-align: center;
		font-size: 0.6875rem;
		color: var(--surface-muted);
		opacity: 0.6;
		margin-top: 1.5rem;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.01em;
	}
	@media (max-width: 640px) {
		.us-content {
			padding: 1.5rem 1rem 3rem;
		}
	}
</style>
