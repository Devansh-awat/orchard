<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { apiFetch, user, toasts } from '$lib/stores';
	import { ArrowLeft, Loader2, Pencil, Camera, X, UserPlus, Trash2, ChevronDown, Check, Mail, Building2, Users, CreditCard, Shield, Globe, Key, Lock } from 'lucide-svelte';
	import { fade, scale } from 'svelte/transition';
	import { Avatar as AvatarBuilder } from 'melt/builders';

	interface Member {
		id: string;
		role: 'owner' | 'admin' | 'member';
		user: {
			id: string;
			firstName?: string;
			lastName?: string;
			email: string;
			imageUrl?: string;
			username?: string;
		};
	}

	interface Organization {
		id: string;
		name: string;
		slug: string;
		description?: string;
		avatarUrl?: string;
		workspaces?: unknown[];
		members?: Member[];
	}

	interface Invitation {
		id: string;
		email: string;
		role: 'owner' | 'admin' | 'member';
		createdAt: string;
		expiresAt: string;
		inviter: {
			firstName?: string;
			lastName?: string;
			username?: string;
			email: string;
		};
	}

	let organization = $state<Organization | null>(null);
	let members = $state<Member[]>([]);
	let invitations = $state<Invitation[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let currentUserRole = $state<'owner' | 'admin' | 'member' | null>(null);

	// Edit state
	let isEditing = $state(false);
	let editingName = $state('');
	let editingDescription = $state('');
	let updating = $state(false);

	// Avatar state
	let uploadingAvatar = $state(false);
	let deletingAvatar = $state(false);
	let avatarInput: HTMLInputElement;

	// Member state
	let newMemberEmail = $state('');
	let newMemberRole = $state<'member' | 'admin' | 'owner'>('member');
	let addingMember = $state(false);
	let inviteRoleOpen = $state(false);
	let memberRoleOpen = $state<string | null>(null);

	// Invitation state
	let resendingInvitationId = $state<string | null>(null);
	let cancellingInvitationId = $state<string | null>(null);

	const roleOptions: Array<{ value: 'member' | 'admin' | 'owner'; label: string }> = [
		{ value: 'member', label: 'Member' },
		{ value: 'admin', label: 'Admin' },
		{ value: 'owner', label: 'Owner' }
	];

	const organizationSlug = $derived($page.params.orgSlug);
	const canEditOrg = $derived(currentUserRole === 'owner' || currentUserRole === 'admin');
	const canInvite = $derived(currentUserRole === 'owner' || currentUserRole === 'admin');
	const isOwner = $derived(currentUserRole === 'owner');

	const orgAvatar = new AvatarBuilder({
		src: () => organization?.avatarUrl,
		delayMs: 120
	});

	function formatRole(role: string) {
		return role.charAt(0).toUpperCase() + role.slice(1);
	}

	async function fetchOrganization() {
		loading = true;
		error = null;

		try {
			const response = await apiFetch(`/apiv1/organizations/slug/${organizationSlug}`);
			if (!response.ok) {
				throw new Error('Failed to fetch organization');
			}

			const data = await response.json();
			organization = data;
			members = data.members || [];

			const roleResponse = await apiFetch(`/apiv1/organizations/${data.id}/members/me`);
			if (roleResponse.ok) {
				const roleData = await roleResponse.json();
				currentUserRole = roleData.role;

				if (roleData.role === 'owner' || roleData.role === 'admin') {
					await fetchInvitations();
					await fetchBackupSettings();
				}
				// Load SSO config for enterprise orgs
				if (data.plan === 'enterprise') {
					ssoSubdomain = data.subdomain || '';
					await fetchSsoConfig();
				}
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to fetch organization';
		} finally {
			loading = false;
		}
	}

	function startEditing() {
		editingName = organization?.name || '';
		editingDescription = organization?.description || '';
		isEditing = true;
	}

	function cancelEditing() {
		isEditing = false;
	}

	async function saveOrganization() {
		if (!organization) return;

		updating = true;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: editingName,
					description: editingDescription
				})
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to update organization');
			}

			toasts.add({ title: 'Organization updated', color: 'success' });
			isEditing = false;
			fetchOrganization();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update',
				color: 'error'
			});
		} finally {
			updating = false;
		}
	}

	async function uploadAvatar(event: Event) {
		if (!organization || !canEditOrg) return;

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

			const response = await apiFetch(`/apiv1/organizations/${organization.id}/avatar`, {
				method: 'POST',
				body: formData
			});

			if (!response.ok) throw new Error('Failed to upload avatar');

			toasts.add({ title: 'Avatar updated', color: 'success' });
			fetchOrganization();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to upload avatar', color: 'error' });
		} finally {
			uploadingAvatar = false;
			if (avatarInput) avatarInput.value = '';
		}
	}

	async function deleteAvatar() {
		if (!organization || !canEditOrg) return;

		deletingAvatar = true;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/avatar`, { method: 'DELETE' });
			if (!response.ok) throw new Error('Failed to delete avatar');

			toasts.add({ title: 'Avatar removed', color: 'success' });
			fetchOrganization();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to delete avatar', color: 'error' });
		} finally {
			deletingAvatar = false;
		}
	}

	async function addMember() {
		if (!organization || !newMemberEmail) return;

		addingMember = true;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/members`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: newMemberEmail, role: newMemberRole })
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to add member');
			}

			toasts.add({ title: 'Member added', color: 'success' });
			newMemberEmail = '';
			newMemberRole = 'member';
			await fetchOrganization();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to add member', color: 'error' });
		} finally {
			addingMember = false;
		}
	}

	async function removeMember(memberId: string) {
		if (!organization) return;

		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/members/${memberId}`, { method: 'DELETE' });
			if (!response.ok) throw new Error('Failed to remove member');

			toasts.add({ title: 'Member removed', color: 'success' });
			fetchOrganization();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to remove member', color: 'error' });
		}
	}

	async function updateMemberRole(memberId: string, newRole: 'owner' | 'admin' | 'member') {
		if (!organization) return;

		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/members/${memberId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ role: newRole })
			});

			if (!response.ok) throw new Error('Failed to update member role');

			toasts.add({ title: 'Role updated', color: 'success' });
			fetchOrganization();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to update role', color: 'error' });
		}
	}

	async function fetchInvitations() {
		if (!organization) return;

		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/invitations`);
			if (response.ok) {
				invitations = await response.json();
			}
		} catch (e) {
			console.error('Failed to fetch invitations:', e);
		}
	}

	async function resendInvitation(invitationId: string) {
		if (!organization) return;

		resendingInvitationId = invitationId;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/invitations/${invitationId}/resend`, { method: 'POST' });
			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to resend invitation');
			}

			toasts.add({ title: 'Invitation resent', color: 'success' });
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to resend invitation', color: 'error' });
		} finally {
			resendingInvitationId = null;
		}
	}

	async function cancelInvitation(invitationId: string) {
		if (!organization) return;

		cancellingInvitationId = invitationId;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/invitations/${invitationId}`, { method: 'DELETE' });
			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to cancel invitation');
			}

			toasts.add({ title: 'Invitation cancelled', color: 'success' });
			invitations = invitations.filter(inv => inv.id !== invitationId);
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to cancel invitation', color: 'error' });
		} finally {
			cancellingInvitationId = null;
		}
	}

	// Backup (R2) settings state
	let backupLoading = $state(false);
	let backupSaving = $state(false);
	let backupEndpoint = $state('');
	let backupBucket = $state('');
	let backupRegion = $state('auto');
	let backupAccessKey = $state('');
	let backupSecretKey = $state('');
	let backupSecretConfigured = $state(false);

	// Shared public IP for database exposure
	let publicIp = $state('');
	let publicIpSaving = $state(false);

	async function fetchBackupSettings() {
		if (!organization) return;
		backupLoading = true;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/backup-settings`);
			if (!response.ok) return;
			const data = await response.json();
			backupEndpoint = data.endpoint || '';
			backupBucket = data.bucket || '';
			backupRegion = data.region || 'auto';
			backupAccessKey = data.accessKey || '';
			backupSecretConfigured = Boolean(data.secretKeyConfigured);
			backupSecretKey = '';
			publicIp = data.databasePublicIp || '';
		} finally {
			backupLoading = false;
		}
	}

	async function savePublicIp() {
		if (!organization) return;
		publicIpSaving = true;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ databasePublicIp: publicIp.trim() || null }),
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to save');
			}
			toasts.add({
				title: publicIp.trim() ? 'Public IP saved' : 'Public IP cleared',
				color: 'success',
			});
			await fetchBackupSettings();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to save', color: 'error' });
		} finally {
			publicIpSaving = false;
		}
	}

	async function saveBackupSettings() {
		if (!organization) return;
		backupSaving = true;
		try {
			const body: Record<string, string | null> = {
				backupR2Endpoint: backupEndpoint.trim() || null,
				backupR2Bucket: backupBucket.trim() || null,
				backupR2Region: backupRegion.trim() || null,
				backupR2AccessKey: backupAccessKey.trim() || null,
			};
			if (backupSecretKey.trim()) {
				body.backupR2SecretKey = backupSecretKey.trim();
			}
			const response = await apiFetch(`/apiv1/organizations/${organization.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.message || 'Failed to save');
			}
			toasts.add({ title: 'Backup settings saved', color: 'success' });
			backupSecretKey = '';
			await fetchBackupSettings();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to save', color: 'error' });
		} finally {
			backupSaving = false;
		}
	}

	async function clearBackupSettings() {
		if (!organization) return;
		if (!confirm('Clear R2 backup configuration? Existing backups remain but new ones will be disabled.')) return;
		backupSaving = true;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					backupR2Endpoint: null,
					backupR2Bucket: null,
					backupR2Region: null,
					backupR2AccessKey: null,
					backupR2SecretKey: null,
				}),
			});
			if (!response.ok) throw new Error('Failed to clear');
			toasts.add({ title: 'Backup settings cleared', color: 'success' });
			backupEndpoint = '';
			backupBucket = '';
			backupRegion = 'auto';
			backupAccessKey = '';
			backupSecretKey = '';
			backupSecretConfigured = false;
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to clear', color: 'error' });
		} finally {
			backupSaving = false;
		}
	}

	// SSO state
	let ssoTab = $state<'config' | 'branding'>('config');
	let ssoConfig = $state<any>(null);
	let ssoLoading = $state(false);
	let ssoSaving = $state(false);
	let ssoSubdomain = $state('');
	let ssoSubdomainSaving = $state(false);
	let ssoProvider = $state<'oidc' | 'saml'>('oidc');
	let ssoOidcIssuerUrl = $state('');
	let ssoOidcClientId = $state('');
	let ssoOidcClientSecret = $state('');
	let ssoOidcScopes = $state('openid email profile');
	let ssoSamlEntryPoint = $state('');
	let ssoSamlIssuer = $state('');
	let ssoSamlCertificate = $state('');
	let ssoSamlMetadataUrl = $state('');
	let ssoEnabled = $state(false);
	let ssoEnforced = $state(false);
	let ssoLoginLogoUrl = $state('');
	let ssoLoginPrimaryColor = $state('#6366f1');
	let ssoLoginBgColor = $state('#0a0a0f');
	let ssoLoginWelcomeText = $state('');
	let ssoTestResult = $state<{ success: boolean; testLoginUrl?: string; error?: string } | null>(null);
	let ssoTesting = $state(false);

	const isEnterprise = $derived(organization?.plan === 'enterprise');
	const baseDomain = import.meta.env.VITE_BASE_DOMAIN || 'orchard.my';

	async function fetchSsoConfig() {
		if (!organization || !isEnterprise) return;

		ssoLoading = true;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/sso`);
			if (response.ok) {
				const data = await response.json();
				if (data && !data.configured === false) {
					ssoConfig = data;
					ssoProvider = data.provider || 'oidc';
					ssoOidcIssuerUrl = data.oidcIssuerUrl || '';
					ssoOidcClientId = data.oidcClientId || '';
					ssoOidcScopes = data.oidcScopes || 'openid email profile';
					ssoSamlEntryPoint = data.samlEntryPoint || '';
					ssoSamlIssuer = data.samlIssuer || '';
					ssoSamlMetadataUrl = data.samlMetadataUrl || '';
					ssoEnabled = data.enabled || false;
					ssoEnforced = data.enforced || false;
					ssoLoginLogoUrl = data.loginLogoUrl || '';
					ssoLoginPrimaryColor = data.loginPrimaryColor || '#6366f1';
					ssoLoginBgColor = data.loginBgColor || '#0a0a0f';
					ssoLoginWelcomeText = data.loginWelcomeText || '';
				}
			}
		} catch (e) {
			console.error('Failed to fetch SSO config:', e);
		} finally {
			ssoLoading = false;
		}
	}

	async function saveSsoConfig() {
		if (!organization) return;

		ssoSaving = true;
		try {
			const body: any = {
				provider: ssoProvider,
				enabled: ssoEnabled,
				enforced: ssoEnforced,
				loginLogoUrl: ssoLoginLogoUrl || null,
				loginPrimaryColor: ssoLoginPrimaryColor || null,
				loginBgColor: ssoLoginBgColor || null,
				loginWelcomeText: ssoLoginWelcomeText || null,
			};

			if (ssoProvider === 'oidc') {
				body.oidcIssuerUrl = ssoOidcIssuerUrl;
				body.oidcClientId = ssoOidcClientId;
				if (ssoOidcClientSecret) body.oidcClientSecret = ssoOidcClientSecret;
				body.oidcScopes = ssoOidcScopes;
			} else {
				body.samlEntryPoint = ssoSamlEntryPoint;
				body.samlIssuer = ssoSamlIssuer;
				if (ssoSamlCertificate) body.samlCertificate = ssoSamlCertificate;
				body.samlMetadataUrl = ssoSamlMetadataUrl;
			}

			const response = await apiFetch(`/apiv1/organizations/${organization.id}/sso`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to save SSO config');
			}

			toasts.add({ title: 'SSO configuration saved', color: 'success' });
			ssoOidcClientSecret = '';
			ssoSamlCertificate = '';
			await fetchSsoConfig();
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to save', color: 'error' });
		} finally {
			ssoSaving = false;
		}
	}

	async function saveSubdomain() {
		if (!organization) return;

		ssoSubdomainSaving = true;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/subdomain`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ subdomain: ssoSubdomain || null }),
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.message || 'Failed to update subdomain');
			}

			toasts.add({ title: 'Subdomain updated', color: 'success' });
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to save', color: 'error' });
		} finally {
			ssoSubdomainSaving = false;
		}
	}

	async function testSsoConnection() {
		if (!organization) return;

		ssoTesting = true;
		ssoTestResult = null;
		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/sso/test`, {
				method: 'POST',
			});
			ssoTestResult = await response.json();
		} catch (e) {
			ssoTestResult = { success: false, error: 'Failed to test connection' };
		} finally {
			ssoTesting = false;
		}
	}

	async function deleteSsoConfig() {
		if (!organization) return;

		try {
			const response = await apiFetch(`/apiv1/organizations/${organization.id}/sso`, { method: 'DELETE' });
			if (!response.ok) throw new Error('Failed to delete');

			toasts.add({ title: 'SSO configuration deleted', color: 'success' });
			ssoConfig = null;
			ssoEnabled = false;
			ssoEnforced = false;
		} catch (e) {
			toasts.add({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to delete', color: 'error' });
		}
	}

	onMount(() => {
		fetchOrganization();
	});
</script>

{#if error}
	<div class="os-page"><div class="alert alert-error">{error}</div></div>
{/if}

{#if loading}
	<div class="os-page">
		<div class="flex justify-center py-16">
			<Loader2 class="h-6 w-6 animate-spin text-primary-600" />
		</div>
	</div>
{:else if organization}
	<div class="os-page">
		<button onclick={() => window.history.back()} class="os-back">
			<ArrowLeft class="h-4 w-4" />
			Back
		</button>

		<!-- Header -->
		<div class="os-header">
			<div class="os-header-left">
				<div class="os-avatar-wrap">
					<div class="os-avatar">
						<img {...orgAvatar.image} alt={organization.name} class="os-avatar-img" />
						<span {...orgAvatar.fallback} class="os-avatar-fallback">
							{organization.name[0]}
						</span>
					</div>
					{#if canEditOrg}
						<input bind:this={avatarInput} type="file" accept="image/jpeg,image/png,image/gif,image/webp" class="hidden" onchange={uploadAvatar} />
						<button onclick={() => avatarInput?.click()} disabled={uploadingAvatar} class="os-avatar-edit">
							{#if uploadingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Camera class="h-3 w-3" />{/if}
						</button>
						{#if organization.avatarUrl}
							<button onclick={deleteAvatar} disabled={deletingAvatar} class="os-avatar-remove">
								{#if deletingAvatar}<Loader2 class="h-3 w-3 animate-spin" />{:else}<X class="h-3 w-3" />{/if}
							</button>
						{/if}
					{/if}
				</div>
				<div>
					<h1 class="os-title">{organization.name}</h1>
					<p class="os-slug">{organization.slug}</p>
				</div>
			</div>
			{#if canEditOrg && !isEditing}
				<button onclick={startEditing} class="btn btn-secondary">
					<Pencil class="h-4 w-4" />
					Edit
				</button>
			{/if}
		</div>

		<!-- Edit form -->
		{#if isEditing}
			<div class="os-card" transition:fade={{ duration: 150 }}>
				<div class="os-card-body">
					<div class="os-edit-grid">
						<div class="os-field">
							<label for="org-name" class="os-field-label">Name</label>
							<input id="org-name" type="text" bind:value={editingName} class="input" />
						</div>
						<div class="os-field">
							<label for="org-desc" class="os-field-label">Description</label>
							<textarea id="org-desc" bind:value={editingDescription} rows="2" class="input"></textarea>
						</div>
					</div>
					<div class="os-edit-actions">
						<button onclick={cancelEditing} class="btn btn-secondary">Cancel</button>
						<button onclick={saveOrganization} disabled={updating} class="btn btn-primary">
							{#if updating}<Loader2 class="h-4 w-4 animate-spin" />{/if}
							Save
						</button>
					</div>
				</div>
			</div>
		{/if}

		<!-- Stats row -->
		<div class="os-stats">
			<div class="os-stat">
				<div class="os-stat-icon"><Building2 class="h-4 w-4" /></div>
				<div>
					<p class="os-stat-value">{organization.workspaces?.length || 0}</p>
					<p class="os-stat-label">Workspaces</p>
				</div>
			</div>
			<div class="os-stat">
				<div class="os-stat-icon"><Users class="h-4 w-4" /></div>
				<div>
					<p class="os-stat-value">{members.length}</p>
					<p class="os-stat-label">Members</p>
				</div>
			</div>
			<div class="os-stat">
				<div class="os-stat-icon"><Shield class="h-4 w-4" /></div>
				<div>
					<p class="os-stat-value">{formatRole(currentUserRole || 'member')}</p>
					<p class="os-stat-label">Your role</p>
				</div>
			</div>
			{#if isOwner && organization?.plan}
				<div class="os-stat">
					<div class="os-stat-icon"><CreditCard class="h-4 w-4" /></div>
					<div>
						<p class="os-stat-value">{organization.plan.charAt(0).toUpperCase() + organization.plan.slice(1)}</p>
						<p class="os-stat-label">Plan</p>
					</div>
				</div>
			{/if}
		</div>

		<!-- Members -->
		<div class="os-card">
			<div class="os-card-header">
				<h2 class="os-card-title">Members</h2>
				<span class="os-card-count">{members.length}</span>
			</div>

			{#if canInvite}
				<div class="os-invite-bar">
					<input
						type="email"
						bind:value={newMemberEmail}
						placeholder="Email address"
						class="input flex-1"
					/>
					<div class="relative">
						<button
							type="button"
							onclick={() => (inviteRoleOpen = !inviteRoleOpen)}
							class="os-role-trigger"
						>
							<span>{roleOptions.find((r) => r.value === newMemberRole)?.label || 'Role'}</span>
							<ChevronDown class="h-3.5 w-3.5" />
						</button>
						{#if inviteRoleOpen}
							<div class="os-role-dropdown" transition:scale={{ duration: 120, start: 0.96 }}>
								{#each roleOptions as option}
									<button
										type="button"
										onclick={() => { newMemberRole = option.value; inviteRoleOpen = false; }}
										class="os-role-option"
									>
										<span>{option.label}</span>
										{#if newMemberRole === option.value}<Check class="h-3.5 w-3.5 text-primary-600" />{/if}
									</button>
								{/each}
							</div>
						{/if}
					</div>
					<button onclick={addMember} disabled={addingMember || !newMemberEmail} class="btn btn-primary">
						{#if addingMember}<Loader2 class="h-4 w-4 animate-spin" />{:else}<UserPlus class="h-4 w-4" />{/if}
						Invite
					</button>
				</div>
			{/if}

			<div class="os-member-list">
				{#each members as member}
					<div class="os-member">
						<div class="os-member-left">
							{#if member.user.imageUrl}
								<img src={member.user.imageUrl} alt={member.user.firstName || member.user.email} class="os-member-avatar" />
							{:else}
								<div class="os-member-avatar-fallback">
									{member.user.firstName?.[0] || member.user.email[0].toUpperCase()}
								</div>
							{/if}
							<div class="os-member-info">
								<p class="os-member-name">
									{member.user.firstName || ''} {member.user.lastName || ''}
								</p>
								<p class="os-member-email">{member.user.email}</p>
							</div>
						</div>
						<div class="os-member-right">
							{#if isOwner}
								<div class="relative">
									<button
										type="button"
										onclick={() => (memberRoleOpen = memberRoleOpen === member.id ? null : member.id)}
										class="os-role-trigger"
									>
										<span>{formatRole(member.role)}</span>
										<ChevronDown class="h-3.5 w-3.5" />
									</button>
									{#if memberRoleOpen === member.id}
										<div class="os-role-dropdown" transition:scale={{ duration: 120, start: 0.96 }}>
											{#each roleOptions as option}
												<button
													type="button"
													onclick={() => { updateMemberRole(member.id, option.value); memberRoleOpen = null; }}
													class="os-role-option"
												>
													<span>{option.label}</span>
													{#if member.role === option.value}<Check class="h-3.5 w-3.5 text-primary-600" />{/if}
												</button>
											{/each}
										</div>
									{/if}
								</div>
							{:else}
								<span class="os-role-badge">{formatRole(member.role)}</span>
							{/if}
							{#if canInvite && member.role !== 'owner'}
								<button onclick={() => removeMember(member.id)} class="os-member-remove" title="Remove member">
									<Trash2 class="h-3.5 w-3.5" />
								</button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Pending Invitations -->
		{#if canInvite && invitations.length > 0}
			<div class="os-card">
				<div class="os-card-header">
					<h2 class="os-card-title">Pending Invitations</h2>
					<span class="os-card-count">{invitations.length}</span>
				</div>
				<div class="os-member-list">
					{#each invitations as invitation}
						<div class="os-member">
							<div class="os-member-left">
								<div class="os-member-avatar-fallback os-member-avatar-pending">
									<Mail class="h-3.5 w-3.5" />
								</div>
								<div class="os-member-info">
									<p class="os-member-name">{invitation.email}</p>
									<p class="os-member-email">
										Invited {new Date(invitation.createdAt).toLocaleDateString()} · Expires {new Date(invitation.expiresAt).toLocaleDateString()}
									</p>
								</div>
							</div>
							<div class="os-member-right">
								<span class="os-role-badge">{formatRole(invitation.role)}</span>
								<button
									onclick={() => resendInvitation(invitation.id)}
									disabled={resendingInvitationId === invitation.id}
									class="os-member-action"
									title="Resend"
								>
									{#if resendingInvitationId === invitation.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Mail class="h-3.5 w-3.5" />{/if}
								</button>
								<button
									onclick={() => cancelInvitation(invitation.id)}
									disabled={cancellingInvitationId === invitation.id}
									class="os-member-remove"
									title="Cancel"
								>
									{#if cancellingInvitationId === invitation.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<X class="h-3.5 w-3.5" />{/if}
								</button>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Public Database IP -->
		{#if canEditOrg}
			<div class="os-card">
				<div class="os-card-header">
					<h2 class="os-card-title">
						<Globe class="h-4 w-4" />
						Public Database IP
					</h2>
				</div>

				<p class="os-sso-hint" style="margin-bottom: 1rem;">
					Shared external IP used to expose databases publicly. Databases opted into public
					exposure will share this IP with unique ports per database.
				</p>

				<div class="os-sso-section">
					<h3 class="os-sso-section-title">IPv4 / IPv6 Address</h3>
					<div style="display: flex; gap: 0.5rem; align-items: center;">
						<input
							type="text"
							class="input"
							placeholder="e.g. 203.0.113.10"
							bind:value={publicIp}
							style="flex: 1;"
						/>
						<button onclick={savePublicIp} disabled={publicIpSaving} class="btn btn-primary">
							{#if publicIpSaving}<Loader2 class="h-4 w-4 animate-spin" />{/if}
							Save
						</button>
					</div>
				</div>
			</div>
		{/if}

		<!-- Database Backups (R2) -->
		{#if canEditOrg}
			<div class="os-card">
				<div class="os-card-header">
					<h2 class="os-card-title">
						<Shield class="h-4 w-4" />
						Database Backups
					</h2>
				</div>

				<p class="os-sso-hint" style="margin-bottom: 1rem;">
					Configure a Cloudflare R2 bucket to enable pgBackRest backups and restores for databases in this organization.
				</p>

				{#if backupLoading}
					<div class="os-sso-loading"><Loader2 class="h-5 w-5 animate-spin" /></div>
				{:else}
					<div class="os-sso-section">
						<h3 class="os-sso-section-title">R2 Endpoint</h3>
						<input
							type="text"
							class="input"
							placeholder="https://<account-id>.r2.cloudflarestorage.com"
							bind:value={backupEndpoint}
						/>
					</div>

					<div class="os-sso-section">
						<h3 class="os-sso-section-title">Bucket</h3>
						<input
							type="text"
							class="input"
							placeholder="orchard-backups"
							bind:value={backupBucket}
						/>
					</div>

					<div class="os-sso-section">
						<h3 class="os-sso-section-title">Region</h3>
						<input
							type="text"
							class="input"
							placeholder="auto"
							bind:value={backupRegion}
						/>
					</div>

					<div class="os-sso-section">
						<h3 class="os-sso-section-title">Access Key ID</h3>
						<input
							type="text"
							class="input"
							placeholder="R2 access key"
							bind:value={backupAccessKey}
						/>
					</div>

					<div class="os-sso-section">
						<h3 class="os-sso-section-title">
							Secret Access Key
							{#if backupSecretConfigured}
								<span class="os-sso-hint" style="font-weight: 400; margin-left: 0.5rem;">(configured · leave empty to keep)</span>
							{/if}
						</h3>
						<input
							type="password"
							class="input"
							placeholder={backupSecretConfigured ? '••••••••••••' : 'R2 secret key'}
							bind:value={backupSecretKey}
						/>
					</div>

					<div class="os-sso-section" style="display: flex; gap: 0.5rem;">
						<button onclick={saveBackupSettings} disabled={backupSaving} class="btn btn-primary">
							{#if backupSaving}<Loader2 class="h-4 w-4 animate-spin" />{/if}
							Save backup settings
						</button>
						{#if backupSecretConfigured}
							<button onclick={clearBackupSettings} disabled={backupSaving} class="btn btn-secondary">
								Clear
							</button>
						{/if}
					</div>
				{/if}
			</div>
		{/if}

		<!-- SSO Configuration (Enterprise only) -->
		{#if isEnterprise && isOwner}
			<div class="os-card">
				<div class="os-card-header">
					<h2 class="os-card-title">
						<Key class="h-4 w-4" />
						Single Sign-On (SSO)
					</h2>
				</div>

				{#if ssoLoading}
					<div class="os-sso-loading">
						<Loader2 class="h-5 w-5 animate-spin" />
					</div>
				{:else}
					<!-- Subdomain -->
					<div class="os-sso-section">
						<h3 class="os-sso-section-title">
							<Globe class="h-3.5 w-3.5" />
							Custom Subdomain
						</h3>
						<div class="os-sso-subdomain-row">
							<input
								type="text"
								bind:value={ssoSubdomain}
								placeholder="yourcompany"
								class="input os-sso-subdomain-input"
							/>
							<span class="os-sso-subdomain-suffix">.{baseDomain}</span>
							<button
								onclick={saveSubdomain}
								disabled={ssoSubdomainSaving}
								class="btn btn-secondary"
							>
								{#if ssoSubdomainSaving}<Loader2 class="h-4 w-4 animate-spin" />{/if}
								Save
							</button>
						</div>
						{#if ssoSubdomain}
							<p class="os-sso-hint">Your login page will be at <strong>https://{ssoSubdomain}.{baseDomain}</strong></p>
						{/if}
					</div>

					<!-- SSO tabs -->
					<div class="os-sso-tabs">
						<button
							class="os-sso-tab"
							class:os-sso-tab-active={ssoTab === 'config'}
							onclick={() => { ssoTab = 'config'; }}
						>
							Provider Configuration
						</button>
						<button
							class="os-sso-tab"
							class:os-sso-tab-active={ssoTab === 'branding'}
							onclick={() => { ssoTab = 'branding'; }}
						>
							Login Page Customization
						</button>
					</div>

					{#if ssoTab === 'config'}
						<!-- Provider selection -->
						<div class="os-sso-section">
							<h3 class="os-sso-section-title">Provider Type</h3>
							<div class="os-sso-provider-toggle">
								<button
									class="os-sso-provider-btn"
									class:os-sso-provider-active={ssoProvider === 'oidc'}
									onclick={() => { ssoProvider = 'oidc'; }}
								>
									OpenID Connect (OIDC)
								</button>
								<button
									class="os-sso-provider-btn"
									class:os-sso-provider-active={ssoProvider === 'saml'}
									onclick={() => { ssoProvider = 'saml'; }}
								>
									SAML 2.0
								</button>
							</div>
						</div>

						<!-- OIDC config -->
						{#if ssoProvider === 'oidc'}
							<div class="os-sso-section">
								<div class="os-sso-field">
									<label class="os-field-label" for="oidc-issuer">Issuer URL</label>
									<input id="oidc-issuer" type="url" bind:value={ssoOidcIssuerUrl} placeholder="https://accounts.google.com" class="input" />
								</div>
								<div class="os-sso-field">
									<label class="os-field-label" for="oidc-client-id">Client ID</label>
									<input id="oidc-client-id" type="text" bind:value={ssoOidcClientId} placeholder="your-client-id" class="input" />
								</div>
								<div class="os-sso-field">
									<label class="os-field-label" for="oidc-client-secret">Client Secret</label>
									<input id="oidc-client-secret" type="password" bind:value={ssoOidcClientSecret} placeholder={ssoConfig?.oidcClientSecret === '••••••••' ? '(already set, leave blank to keep)' : 'your-client-secret'} class="input" />
								</div>
								<div class="os-sso-field">
									<label class="os-field-label" for="oidc-scopes">Scopes</label>
									<input id="oidc-scopes" type="text" bind:value={ssoOidcScopes} placeholder="openid email profile" class="input" />
								</div>
							</div>
						{/if}

						<!-- SAML config -->
						{#if ssoProvider === 'saml'}
							<div class="os-sso-section">
								<div class="os-sso-field">
									<label class="os-field-label" for="saml-metadata">Metadata URL (optional)</label>
									<input id="saml-metadata" type="url" bind:value={ssoSamlMetadataUrl} placeholder="https://idp.example.com/metadata" class="input" />
								</div>
								<div class="os-sso-field">
									<label class="os-field-label" for="saml-entry">SSO Entry Point URL</label>
									<input id="saml-entry" type="url" bind:value={ssoSamlEntryPoint} placeholder="https://idp.example.com/sso" class="input" />
								</div>
								<div class="os-sso-field">
									<label class="os-field-label" for="saml-issuer">Issuer</label>
									<input id="saml-issuer" type="text" bind:value={ssoSamlIssuer} placeholder="urn:idp:example" class="input" />
								</div>
								<div class="os-sso-field">
									<label class="os-field-label" for="saml-cert">IdP Certificate (PEM)</label>
									<textarea id="saml-cert" bind:value={ssoSamlCertificate} rows="4" placeholder={ssoConfig?.samlCertificate === '(configured)' ? '(already set, leave blank to keep)' : 'Paste the X.509 certificate here...'} class="input"></textarea>
								</div>
							</div>
						{/if}

						<!-- Toggles -->
						<div class="os-sso-section">
							<div class="os-sso-toggle-row">
								<div>
									<p class="os-sso-toggle-label">Enable SSO</p>
									<p class="os-sso-toggle-desc">Allow members to sign in via your identity provider</p>
								</div>
								<label class="os-sso-switch">
									<input type="checkbox" bind:checked={ssoEnabled} />
									<span class="os-sso-slider"></span>
								</label>
							</div>
							<div class="os-sso-toggle-row">
								<div>
									<p class="os-sso-toggle-label">Enforce SSO</p>
									<p class="os-sso-toggle-desc">Require SSO for all members (disables email/passkey login on subdomain)</p>
								</div>
								<label class="os-sso-switch">
									<input type="checkbox" bind:checked={ssoEnforced} />
									<span class="os-sso-slider"></span>
								</label>
							</div>
						</div>

						<!-- Actions -->
						<div class="os-sso-actions">
							<button onclick={saveSsoConfig} disabled={ssoSaving} class="btn btn-primary">
								{#if ssoSaving}<Loader2 class="h-4 w-4 animate-spin" />{/if}
								Save SSO Configuration
							</button>
							<button onclick={testSsoConnection} disabled={ssoTesting} class="btn btn-secondary">
								{#if ssoTesting}<Loader2 class="h-4 w-4 animate-spin" />{/if}
								Test Connection
							</button>
							{#if ssoConfig}
								<button onclick={deleteSsoConfig} class="btn btn-secondary" style="color: var(--error-color, #ef4444);">
									Delete SSO Config
								</button>
							{/if}
						</div>

						{#if ssoTestResult}
							<div class="os-sso-test-result" class:os-sso-test-success={ssoTestResult.success} class:os-sso-test-error={!ssoTestResult.success}>
								{#if ssoTestResult.success}
									<p>Connection successful. <a href={ssoTestResult.testLoginUrl} target="_blank" rel="noopener">Test login</a></p>
								{:else}
									<p>Connection failed: {ssoTestResult.error}</p>
								{/if}
							</div>
						{/if}
					{/if}

					{#if ssoTab === 'branding'}
						<div class="os-sso-section">
							<div class="os-sso-field">
								<label class="os-field-label" for="sso-logo">Logo URL</label>
								<input id="sso-logo" type="url" bind:value={ssoLoginLogoUrl} placeholder="https://example.com/logo.png" class="input" />
							</div>
							<div class="os-sso-field">
								<label class="os-field-label" for="sso-welcome">Welcome Text</label>
								<input id="sso-welcome" type="text" bind:value={ssoLoginWelcomeText} placeholder="Sign in to Your Company" class="input" />
							</div>
							<div class="os-sso-color-row">
								<div class="os-sso-field" style="flex: 1;">
									<label class="os-field-label" for="sso-primary-color">Primary Color</label>
									<div class="os-sso-color-input">
										<input id="sso-primary-color" type="color" bind:value={ssoLoginPrimaryColor} />
										<input type="text" bind:value={ssoLoginPrimaryColor} placeholder="#6366f1" class="input" style="flex: 1;" />
									</div>
								</div>
								<div class="os-sso-field" style="flex: 1;">
									<label class="os-field-label" for="sso-bg-color">Background Color</label>
									<div class="os-sso-color-input">
										<input id="sso-bg-color" type="color" bind:value={ssoLoginBgColor} />
										<input type="text" bind:value={ssoLoginBgColor} placeholder="#0a0a0f" class="input" style="flex: 1;" />
									</div>
								</div>
							</div>

							<!-- Preview -->
							<div class="os-sso-preview" style="background: {ssoLoginBgColor};">
								<div class="os-sso-preview-card">
									{#if ssoLoginLogoUrl}
										<img src={ssoLoginLogoUrl} alt="Logo" class="os-sso-preview-logo" />
									{:else}
										<div class="os-sso-preview-icon" style="background: {ssoLoginPrimaryColor}20; color: {ssoLoginPrimaryColor};">
											<Lock class="h-5 w-5" />
										</div>
									{/if}
									<p class="os-sso-preview-text">{ssoLoginWelcomeText || `Sign in to ${organization?.name || 'Organization'}`}</p>
									<div class="os-sso-preview-btn" style="background: {ssoLoginPrimaryColor};">Sign in with SSO</div>
								</div>
							</div>

							<button onclick={saveSsoConfig} disabled={ssoSaving} class="btn btn-primary">
								{#if ssoSaving}<Loader2 class="h-4 w-4 animate-spin" />{/if}
								Save Branding
							</button>
						</div>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.os-page {
		padding: 2.5rem 2.5rem 3rem;
		max-width: 52rem;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.os-back {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		color: var(--surface-muted);
		cursor: pointer;
		transition: color 120ms ease;
		align-self: flex-start;
	}
	.os-back:hover { color: var(--center-channel-color); }

	/* Header */
	.os-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.os-header-left {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.os-avatar-wrap {
		position: relative;
		flex-shrink: 0;
	}

	.os-avatar {
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 0.875rem;
		overflow: hidden;
	}

	.os-avatar-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.os-avatar-fallback {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		font-size: 1.25rem;
		font-weight: 700;
		background-color: color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-bg));
		color: var(--center-channel-color);
	}

	.os-avatar-edit, .os-avatar-remove {
		position: absolute;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		border: 2px solid var(--surface-bg);
		cursor: pointer;
		transition: opacity 120ms ease;
	}
	.os-avatar-edit {
		bottom: -0.25rem;
		right: -0.25rem;
		background-color: var(--button-bg);
		color: var(--button-color);
	}
	.os-avatar-remove {
		top: -0.25rem;
		right: -0.25rem;
		background-color: var(--center-channel-color);
		color: var(--center-channel-bg);
	}

	.os-title {
		font-size: 1.25rem;
		font-weight: 700;
		color: var(--center-channel-color);
		line-height: 1.2;
		letter-spacing: -0.02em;
	}

	.os-slug {
		font-size: 0.8125rem;
		font-family: var(--font-mono);
		color: var(--surface-muted);
		margin-top: 0.125rem;
	}

	/* Stats */
	.os-stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: 0.875rem;
	}

	.os-stat {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		padding: 1rem 1.125rem;
		border-radius: 0.875rem;
		border: 1px solid var(--surface-border);
		background-color: var(--surface-bg);
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}

	.os-stat-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.625rem;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--surface-border) 50%, var(--center-channel-bg));
		color: var(--surface-muted);
	}

	.os-stat-value {
		font-size: 1.0625rem;
		font-weight: 700;
		color: var(--center-channel-color);
		line-height: 1.2;
	}

	.os-stat-label {
		font-size: 0.6875rem;
		color: var(--surface-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-weight: 500;
		margin-top: 0.0625rem;
	}

	/* Cards */
	.os-card {
		border: 1px solid var(--surface-border);
		border-radius: 1rem;
		background-color: var(--surface-bg);
		overflow: hidden;
		box-shadow:
			0 1px 3px rgb(0 0 0 / 0.03),
			0 1px 2px rgb(0 0 0 / 0.02);
	}

	.os-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1.125rem 1.375rem;
		border-bottom: 1px solid var(--surface-border);
	}

	.os-card-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--surface-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.os-card-count {
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.1875rem 0.5rem;
		border-radius: 9999px;
		background-color: color-mix(in srgb, var(--surface-border) 50%, var(--center-channel-bg));
		color: var(--surface-muted);
	}

	.os-card-body {
		padding: 1.375rem;
	}

	/* Edit form */
	.os-edit-grid {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.os-field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.os-field-label {
		font-size: 0.75rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--surface-muted);
	}

	.os-edit-actions {
		display: flex;
		gap: 0.5rem;
		padding-top: 0.75rem;
	}

	/* Invite bar */
	.os-invite-bar {
		display: flex;
		gap: 0.5rem;
		padding: 1rem 1.375rem;
		border-bottom: 1px solid var(--surface-border);
		background-color: color-mix(in srgb, var(--surface-border) 15%, var(--surface-bg));
	}

	/* Member list */
	.os-member-list {
		display: flex;
		flex-direction: column;
	}

	.os-member {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.875rem 1.375rem;
		border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 70%, transparent);
		transition: background-color 80ms ease;
	}
	.os-member:last-child { border-bottom: none; }
	.os-member:hover { background-color: color-mix(in srgb, var(--surface-border) 15%, var(--surface-bg)); }

	.os-member-left {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
		flex: 1;
	}

	.os-member-avatar {
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.os-member-avatar-fallback {
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.75rem;
		font-weight: 600;
		flex-shrink: 0;
		background-color: color-mix(in srgb, var(--surface-border) 80%, var(--center-channel-bg));
		color: var(--center-channel-color);
	}

	.os-member-avatar-pending {
		background-color: color-mix(in srgb, var(--surface-border) 50%, var(--center-channel-bg));
		color: var(--surface-muted);
	}

	.os-member-info {
		min-width: 0;
	}

	.os-member-name {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--center-channel-color);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.os-member-email {
		font-size: 0.75rem;
		color: var(--surface-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.os-member-right {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
	}

	/* Role controls */
	.os-role-trigger {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 0.625rem;
		border-radius: 0.375rem;
		border: 1px solid var(--surface-border);
		background-color: var(--surface-bg);
		color: var(--center-channel-color);
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
		transition: border-color 120ms ease;
	}
	.os-role-trigger:hover { border-color: color-mix(in srgb, var(--surface-border) 50%, var(--center-channel-color)); }

	.os-role-dropdown {
		position: absolute;
		right: 0;
		top: 100%;
		margin-top: 0.25rem;
		z-index: 20;
		width: 8rem;
		padding: 0.25rem;
		border-radius: 0.5rem;
		border: 1px solid var(--surface-border);
		background-color: var(--surface-bg);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
	}

	.os-role-option {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 0.375rem 0.5rem;
		border-radius: 0.375rem;
		font-size: 0.8125rem;
		color: var(--center-channel-color);
		background: transparent;
		cursor: pointer;
		transition: background-color 80ms ease;
	}
	.os-role-option:hover { background-color: var(--control-hover-bg); }

	.os-role-badge {
		padding: 0.25rem 0.5rem;
		border-radius: 0.375rem;
		font-size: 0.6875rem;
		font-weight: 600;
		background-color: color-mix(in srgb, var(--surface-border) 50%, var(--center-channel-bg));
		color: var(--surface-muted);
	}

	.os-member-action {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.375rem;
		border-radius: 0.375rem;
		color: var(--surface-muted);
		background: transparent;
		cursor: pointer;
		transition: color 80ms ease, background-color 80ms ease;
	}
	.os-member-action:hover {
		color: var(--center-channel-color);
		background-color: var(--control-hover-bg);
	}

	.os-member-remove {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.375rem;
		border-radius: 0.375rem;
		color: var(--error-text-color);
		background: transparent;
		cursor: pointer;
		transition: background-color 80ms ease;
	}
	.os-member-remove:hover {
		background-color: color-mix(in srgb, var(--error-text-color) 10%, transparent);
	}

	@media (max-width: 640px) {
		.os-header { flex-direction: column; align-items: flex-start; }
		.os-invite-bar { flex-direction: column; }
		.os-member { flex-direction: column; align-items: flex-start; }
		.os-member-right { align-self: flex-end; }
		.os-stats { grid-template-columns: 1fr 1fr; }
	}

	/* SSO Styles */
	.os-sso-loading {
		display: flex;
		justify-content: center;
		padding: 2rem;
		color: var(--surface-muted);
	}

	.os-sso-section {
		padding: 1rem 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		border-top: 1px solid var(--surface-border);
	}

	.os-sso-section-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--center-channel-color);
		margin: 0;
	}

	.os-sso-subdomain-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.os-sso-subdomain-input {
		max-width: 200px;
	}

	.os-sso-subdomain-suffix {
		font-size: 0.875rem;
		color: var(--surface-muted);
		white-space: nowrap;
	}

	.os-sso-hint {
		font-size: 0.75rem;
		color: var(--surface-muted);
		margin: 0;
	}

	.os-sso-hint strong {
		color: var(--center-channel-color);
	}

	.os-sso-tabs {
		display: flex;
		gap: 0;
		border-bottom: 1px solid var(--surface-border);
		padding: 0 1.25rem;
	}

	.os-sso-tab {
		padding: 0.625rem 1rem;
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--surface-muted);
		cursor: pointer;
		border-bottom: 2px solid transparent;
		transition: color 120ms ease, border-color 120ms ease;
		background: transparent;
		border-top: none;
		border-left: none;
		border-right: none;
	}

	.os-sso-tab:hover {
		color: var(--center-channel-color);
	}

	.os-sso-tab-active {
		color: var(--center-channel-color);
		border-bottom-color: var(--button-bg);
	}

	.os-sso-provider-toggle {
		display: flex;
		gap: 0.5rem;
	}

	.os-sso-provider-btn {
		padding: 0.5rem 1rem;
		font-size: 0.8rem;
		font-weight: 500;
		border-radius: 0.375rem;
		cursor: pointer;
		transition: all 120ms ease;
		background: transparent;
		border: 1px solid var(--surface-border);
		color: var(--surface-muted);
	}

	.os-sso-provider-active {
		background: var(--button-bg);
		color: var(--button-color);
		border-color: var(--button-bg);
	}

	.os-sso-field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.os-sso-toggle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.os-sso-toggle-label {
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--center-channel-color);
		margin: 0;
	}

	.os-sso-toggle-desc {
		font-size: 0.7rem;
		color: var(--surface-muted);
		margin: 0;
	}

	.os-sso-switch {
		position: relative;
		display: inline-block;
		width: 36px;
		height: 20px;
		flex-shrink: 0;
	}

	.os-sso-switch input {
		opacity: 0;
		width: 0;
		height: 0;
	}

	.os-sso-slider {
		position: absolute;
		cursor: pointer;
		inset: 0;
		background-color: var(--surface-border);
		transition: background-color 200ms;
		border-radius: 20px;
	}

	.os-sso-slider::before {
		content: '';
		position: absolute;
		height: 14px;
		width: 14px;
		left: 3px;
		bottom: 3px;
		background-color: white;
		transition: transform 200ms;
		border-radius: 50%;
	}

	.os-sso-switch input:checked + .os-sso-slider {
		background-color: var(--button-bg);
	}

	.os-sso-switch input:checked + .os-sso-slider::before {
		transform: translateX(16px);
	}

	.os-sso-actions {
		display: flex;
		gap: 0.5rem;
		padding: 0.75rem 1.25rem;
		border-top: 1px solid var(--surface-border);
		flex-wrap: wrap;
	}

	.os-sso-test-result {
		margin: 0 1.25rem 1rem;
		padding: 0.75rem 1rem;
		border-radius: 0.5rem;
		font-size: 0.8rem;
	}

	.os-sso-test-success {
		background: color-mix(in srgb, var(--online-indicator) 10%, transparent);
		color: var(--online-indicator);
	}

	.os-sso-test-success a {
		color: inherit;
		text-decoration: underline;
	}

	.os-sso-test-error {
		background: color-mix(in srgb, var(--error-text-color) 10%, transparent);
		color: var(--error-text-color);
	}

	.os-sso-color-row {
		display: flex;
		gap: 1rem;
	}

	.os-sso-color-input {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.os-sso-color-input input[type='color'] {
		width: 32px;
		height: 32px;
		border: 1px solid var(--surface-border);
		border-radius: 0.375rem;
		cursor: pointer;
		padding: 2px;
		background: transparent;
	}

	.os-sso-preview {
		border-radius: 0.75rem;
		padding: 2rem;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--surface-border);
	}

	.os-sso-preview-card {
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 0.75rem;
		padding: 1.5rem;
		width: 260px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
	}

	.os-sso-preview-logo {
		width: 40px;
		height: 40px;
		border-radius: 0.5rem;
		object-fit: cover;
	}

	.os-sso-preview-icon {
		width: 40px;
		height: 40px;
		border-radius: 0.5rem;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.os-sso-preview-text {
		font-size: 0.8rem;
		color: rgba(255, 255, 255, 0.9);
		text-align: center;
		margin: 0;
	}

	.os-sso-preview-btn {
		width: 100%;
		padding: 0.5rem;
		border-radius: 0.375rem;
		text-align: center;
		font-size: 0.75rem;
		font-weight: 500;
		color: white;
	}
</style>
