<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import { apiFetch, toasts, subscribeOrgEvents } from '$lib/stores';
	import { featureFlag } from '$lib/posthog';
	import { env } from '$env/dynamic/public';
	import { Loader2 } from 'lucide-svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import {
		OrgGeneralTab,
		OrgMembersTab,
		OrgDatabaseTab,
		OrgBackupsTab,
		OrgSsoTab,
		OrgScimTab,
		OrgNotificationsTab
	} from '$lib/components/org-settings';
	import type {
		NotificationChannel,
		ChannelPayload
	} from '$lib/components/org-settings/notification-types';

	interface Member {
		id: string;
		role: 'owner' | 'admin' | 'member' | 'guest';
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
		plan?: string;
		workspaces?: unknown[];
		members?: Member[];
		subdomain?: string;
	}

	interface Invitation {
		id: string;
		email: string;
		role: 'owner' | 'admin' | 'member' | 'guest';
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
	let currentUserRole = $state<'owner' | 'admin' | 'member' | 'guest' | null>(null);

	let isEditing = $state(false);
	let editingName = $state('');
	let editingDescription = $state('');
	let updating = $state(false);

	let uploadingAvatar = $state(false);
	let deletingAvatar = $state(false);
	let avatarInput = $state<HTMLInputElement | undefined>(undefined);

	let newMemberEmail = $state('');
	let newMemberRole = $state<'member' | 'admin' | 'owner'>('member');
	let addingMember = $state(false);

	let resendingInvitationId = $state<string | null>(null);
	let cancellingInvitationId = $state<string | null>(null);
	let removingMemberId = $state<string | null>(null);
	let memberToRemove = $state<Member | null>(null);
	let showRemoveMemberModal = $state(false);
	let updatingRoleMemberId = $state<string | null>(null);

	let backupLoading = $state(false);
	let backupSaving = $state(false);
	let backupEndpoint = $state('');
	let backupBucket = $state('');
	let backupRegion = $state('auto');
	let backupAccessKey = $state('');
	let backupSecretKey = $state('');
	let backupAccessKeyConfigured = $state(false);
	let backupAccessKeyLast4 = $state<string | null>(null);
	let backupSecretConfigured = $state(false);
	let backupEditMode = $state(false);
	let publicIp = $state('');
	let publicIpSaving = $state(false);

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
	let ssoTestResult = $state<{ success: boolean; testLoginUrl?: string; error?: string } | null>(
		null
	);
	let ssoTesting = $state(false);
	let ssoDeleting = $state(false);
	let showDeleteSsoModal = $state(false);

	let notifLoading = $state(false);
	let notifChannels = $state<NotificationChannel[]>([]);
	let notifProjects = $state<{ id: string; name: string }[]>([]);
	let notifSaving = $state(false);
	let notifDeletingId = $state<string | null>(null);
	let notifTestingId = $state<string | null>(null);
	let notifTogglingId = $state<string | null>(null);
	let channelToDelete = $state<NotificationChannel | null>(null);
	let showDeleteChannelModal = $state(false);
	let notifCreatedSecret = $state<string | null>(null);

	let scimLoading = $state(false);
	let scimBaseUrl = $state('');
	let scimTokens = $state<
		{
			id: string;
			name: string;
			lastUsedAt: string | null;
			expiresAt: string | null;
			createdAt: string;
		}[]
	>([]);
	let scimNewName = $state('');
	let scimCreating = $state(false);
	let scimRevokingId = $state<string | null>(null);
	let scimCreatedToken = $state<{ name: string; token: string } | null>(null);

	const notificationsEnabled = featureFlag('notifications');
	const organizationSlug = $derived($page.params.orgSlug);
	const activeTab = $derived($page.url.searchParams.get('tab') || 'general');
	const canEditOrg = $derived(currentUserRole === 'owner' || currentUserRole === 'admin');
	const canInvite = $derived(currentUserRole === 'owner' || currentUserRole === 'admin');
	const isOwner = $derived(currentUserRole === 'owner');
	const isEnterprise = $derived(organization?.plan === 'enterprise');
	const baseDomain = env.PUBLIC_BASE_DOMAIN || 'orchard.my';
	const backupConfigured = $derived(
		Boolean(backupEndpoint && backupBucket && backupSecretConfigured)
	);

	async function fetchOrganization() {
		if (!organization) loading = true;
		error = null;
		try {
			const response = await apiFetch(`/apiv1/organizations/slug/${organizationSlug}`);
			if (!response.ok) throw new Error('Failed to fetch organization');
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
					await fetchNotificationChannels();
					if (data.plan === 'enterprise') {
						ssoSubdomain = data.subdomain || '';
						await fetchSsoConfig();
						await fetchScimTokens();
					}
				} else {
					toasts.add({
						title: 'No access',
						description: 'Only organization owners and admins can open settings',
						color: 'error'
					});
					await goto(`/${organizationSlug}`, { replaceState: true });
					return;
				}
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to fetch organization';
		} finally {
			loading = false;
		}
	}

	async function fetchInvitations() {
		if (!organization) return;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/invitations`);
			if (r.ok) invitations = await r.json();
		} catch (e) {
			console.error('Failed to fetch invitations:', e);
		}
	}

	async function fetchBackupSettings() {
		if (!organization) return;
		backupLoading = true;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/backup-settings`);
			if (!r.ok) return;
			const d = await r.json();
			backupEndpoint = d.endpoint || '';
			backupBucket = d.bucket || '';
			backupRegion = d.region || 'auto';
			backupAccessKey = '';
			backupAccessKeyConfigured = Boolean(d.accessKeyConfigured);
			backupAccessKeyLast4 = d.accessKeyLast4 ?? null;
			backupSecretConfigured = Boolean(d.secretKeyConfigured);
			backupSecretKey = '';
			publicIp = d.databasePublicIp || '';
		} finally {
			backupLoading = false;
		}
	}

	async function fetchNotificationChannels() {
		if (!organization) return;
		notifLoading = true;
		try {
			const [channelsRes, projectsRes] = await Promise.all([
				apiFetch(`/apiv1/organizations/${organization.id}/notification-channels`),
				apiFetch(`/apiv1/projects?orgId=${organization.id}`)
			]);
			if (channelsRes.ok) notifChannels = await channelsRes.json();
			if (projectsRes.ok) {
				const projectsData = await projectsRes.json();
				notifProjects = (projectsData || []).map((p: { id: string; name: string }) => ({
					id: p.id,
					name: p.name
				}));
			}
		} catch (e) {
			console.error('Failed to fetch notification channels:', e);
		} finally {
			notifLoading = false;
		}
	}

	async function saveNotificationChannel(
		payload: ChannelPayload,
		channelId: string | null
	): Promise<boolean> {
		if (!organization) return false;
		notifSaving = true;
		try {
			const r = await apiFetch(
				channelId
					? `/apiv1/organizations/${organization.id}/notification-channels/${channelId}`
					: `/apiv1/organizations/${organization.id}/notification-channels`,
				{
					method: channelId ? 'PATCH' : 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload)
				}
			);
			const d = await r.json().catch(() => ({}));
			if (!r.ok) {
				throw new Error(d.message || 'Failed to save channel');
			}
			if (d.webhookSecret) notifCreatedSecret = d.webhookSecret;
			toasts.add({ title: channelId ? 'Channel updated' : 'Channel added', color: 'success' });
			await fetchNotificationChannels();
			return true;
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to save channel',
				color: 'error'
			});
			return false;
		} finally {
			notifSaving = false;
		}
	}

	async function deleteNotificationChannel(channelId: string) {
		if (!organization || notifDeletingId) return;
		notifDeletingId = channelId;
		try {
			const r = await apiFetch(
				`/apiv1/organizations/${organization.id}/notification-channels/${channelId}`,
				{ method: 'DELETE' }
			);
			if (!r.ok) throw new Error('Failed to delete channel');
			toasts.add({ title: 'Channel deleted', color: 'success' });
			notifChannels = notifChannels.filter((c) => c.id !== channelId);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to delete channel',
				color: 'error'
			});
		} finally {
			notifDeletingId = null;
		}
	}

	async function testNotificationChannel(channelId: string) {
		if (!organization || notifTestingId) return;
		notifTestingId = channelId;
		try {
			const r = await apiFetch(
				`/apiv1/organizations/${organization.id}/notification-channels/${channelId}/test`,
				{ method: 'POST' }
			);
			const d = await r.json().catch(() => ({}));
			if (r.ok && d.success) {
				toasts.add({ title: 'Test notification sent', color: 'success' });
			} else {
				throw new Error(d.error || d.message || 'Test delivery failed');
			}
		} catch (e) {
			toasts.add({
				title: 'Test failed',
				description: e instanceof Error ? e.message : 'Test delivery failed',
				color: 'error'
			});
		} finally {
			notifTestingId = null;
			await fetchNotificationChannels();
		}
	}

	async function toggleNotificationChannel(channelId: string, enabled: boolean) {
		if (!organization || notifTogglingId) return;
		notifTogglingId = channelId;
		try {
			const r = await apiFetch(
				`/apiv1/organizations/${organization.id}/notification-channels/${channelId}`,
				{
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ enabled })
				}
			);
			if (!r.ok) throw new Error('Failed to update channel');
			const updated = await r.json();
			notifChannels = notifChannels.map((c) =>
				c.id === channelId ? { ...c, enabled: updated.enabled } : c
			);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update channel',
				color: 'error'
			});
		} finally {
			notifTogglingId = null;
		}
	}

	async function fetchSsoConfig() {
		if (!organization || !isEnterprise) return;
		ssoLoading = true;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/sso`);
			if (r.ok) {
				const d = await r.json();
				if (d && !d.configured === false) {
					ssoConfig = d;
					ssoProvider = d.provider || 'oidc';
					ssoOidcIssuerUrl = d.oidcIssuerUrl || '';
					ssoOidcClientId = d.oidcClientId || '';
					ssoOidcScopes = d.oidcScopes || 'openid email profile';
					ssoSamlEntryPoint = d.samlEntryPoint || '';
					ssoSamlIssuer = d.samlIssuer || '';
					ssoSamlMetadataUrl = d.samlMetadataUrl || '';
					ssoEnabled = d.enabled || false;
					ssoEnforced = d.enforced || false;
					ssoLoginLogoUrl = d.loginLogoUrl || '';
					ssoLoginPrimaryColor = d.loginPrimaryColor || '#6366f1';
					ssoLoginBgColor = d.loginBgColor || '#0a0a0f';
					ssoLoginWelcomeText = d.loginWelcomeText || '';
				}
			}
		} catch (e) {
			console.error('Failed to fetch SSO config:', e);
		} finally {
			ssoLoading = false;
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
			const r = await apiFetch(`/apiv1/organizations/${organization.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: editingName, description: editingDescription })
			});
			if (!r.ok) {
				const d = await r.json();
				throw new Error(d.message || 'Failed to update organization');
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
			const fd = new FormData();
			fd.append('file', file);
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/avatar`, {
				method: 'POST',
				body: fd
			});
			if (!r.ok) throw new Error('Failed to upload avatar');
			toasts.add({ title: 'Avatar updated', color: 'success' });
			fetchOrganization();
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
		if (!organization || !canEditOrg) return;
		deletingAvatar = true;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/avatar`, {
				method: 'DELETE'
			});
			if (!r.ok) throw new Error('Failed to delete avatar');
			toasts.add({ title: 'Avatar removed', color: 'success' });
			fetchOrganization();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to delete avatar',
				color: 'error'
			});
		} finally {
			deletingAvatar = false;
		}
	}

	async function addMember() {
		if (!organization || !newMemberEmail) return;
		addingMember = true;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/members`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: newMemberEmail, role: newMemberRole })
			});
			if (!r.ok) {
				const d = await r.json();
				throw new Error(d.message || 'Failed to add member');
			}
			toasts.add({ title: 'Member added', color: 'success' });
			newMemberEmail = '';
			newMemberRole = 'member';
			await fetchOrganization();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to add member',
				color: 'error'
			});
		} finally {
			addingMember = false;
		}
	}

	function memberDisplayName(member: Member) {
		const name = [member.user.firstName, member.user.lastName].filter(Boolean).join(' ');
		return name || member.user.email;
	}

	function requestRemoveMember(memberId: string) {
		if (removingMemberId) return;
		const member = members.find((m) => m.id === memberId);
		if (!member) return;
		memberToRemove = member;
		showRemoveMemberModal = true;
	}

	async function removeMember(memberId: string) {
		if (!organization || removingMemberId) return;
		removingMemberId = memberId;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/members/${memberId}`, {
				method: 'DELETE'
			});
			if (!r.ok) throw new Error('Failed to remove member');
			toasts.add({ title: 'Member removed', color: 'success' });
			fetchOrganization();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to remove member',
				color: 'error'
			});
		} finally {
			removingMemberId = null;
		}
	}

	async function updateMemberRole(
		memberId: string,
		newRole: 'owner' | 'admin' | 'member' | 'guest'
	) {
		if (!organization || updatingRoleMemberId) return;
		const member = members.find((m) => m.id === memberId);
		if (member && member.role === newRole) return;
		updatingRoleMemberId = memberId;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/members/${memberId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ role: newRole })
			});
			if (!r.ok) throw new Error('Failed to update member role');
			toasts.add({ title: 'Role updated', color: 'success' });
			fetchOrganization();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to update role',
				color: 'error'
			});
		} finally {
			updatingRoleMemberId = null;
		}
	}

	async function resendInvitation(invitationId: string) {
		if (!organization) return;
		resendingInvitationId = invitationId;
		try {
			const r = await apiFetch(
				`/apiv1/organizations/${organization.id}/invitations/${invitationId}/resend`,
				{ method: 'POST' }
			);
			if (!r.ok) {
				const d = await r.json();
				throw new Error(d.message || 'Failed to resend invitation');
			}
			toasts.add({ title: 'Invitation resent', color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to resend invitation',
				color: 'error'
			});
		} finally {
			resendingInvitationId = null;
		}
	}

	async function cancelInvitation(invitationId: string) {
		if (!organization) return;
		cancellingInvitationId = invitationId;
		try {
			const r = await apiFetch(
				`/apiv1/organizations/${organization.id}/invitations/${invitationId}`,
				{ method: 'DELETE' }
			);
			if (!r.ok) {
				const d = await r.json();
				throw new Error(d.message || 'Failed to cancel invitation');
			}
			toasts.add({ title: 'Invitation cancelled', color: 'success' });
			invitations = invitations.filter((inv) => inv.id !== invitationId);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to cancel invitation',
				color: 'error'
			});
		} finally {
			cancellingInvitationId = null;
		}
	}

	async function savePublicIp() {
		if (!organization) return;
		publicIpSaving = true;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ databasePublicIp: publicIp.trim() || null })
			});
			if (!r.ok) {
				const d = await r.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to save');
			}
			toasts.add({
				title: publicIp.trim() ? 'Public IP saved' : 'Public IP cleared',
				color: 'success'
			});
			await fetchBackupSettings();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to save',
				color: 'error'
			});
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
				backupR2Region: backupRegion.trim() || null
			};
			if (backupAccessKey.trim()) body.backupR2AccessKey = backupAccessKey.trim();
			if (backupSecretKey.trim()) body.backupR2SecretKey = backupSecretKey.trim();
			const r = await apiFetch(`/apiv1/organizations/${organization.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!r.ok) {
				const d = await r.json().catch(() => ({}));
				throw new Error(d.message || 'Failed to save');
			}
			toasts.add({ title: 'Backup settings saved', color: 'success' });
			backupSecretKey = '';
			backupEditMode = false;
			await fetchBackupSettings();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to save',
				color: 'error'
			});
		} finally {
			backupSaving = false;
		}
	}

	async function clearBackupSettings() {
		if (!organization) return;
		if (
			!confirm(
				'Clear R2 backup configuration? Existing backups remain but new ones will be disabled.'
			)
		)
			return;
		backupSaving = true;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					backupR2Endpoint: null,
					backupR2Bucket: null,
					backupR2Region: null,
					backupR2AccessKey: null,
					backupR2SecretKey: null
				})
			});
			if (!r.ok) throw new Error('Failed to clear');
			toasts.add({ title: 'Backup settings cleared', color: 'success' });
			backupEndpoint = '';
			backupBucket = '';
			backupRegion = 'auto';
			backupAccessKey = '';
			backupSecretKey = '';
			backupAccessKeyConfigured = false;
			backupAccessKeyLast4 = null;
			backupSecretConfigured = false;
			backupEditMode = false;
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to clear',
				color: 'error'
			});
		} finally {
			backupSaving = false;
		}
	}

	async function saveSubdomain() {
		if (!organization) return;
		ssoSubdomainSaving = true;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/subdomain`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ subdomain: ssoSubdomain || null })
			});
			if (!r.ok) {
				const d = await r.json();
				throw new Error(d.message || 'Failed to update subdomain');
			}
			toasts.add({ title: 'Subdomain updated', color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to save',
				color: 'error'
			});
		} finally {
			ssoSubdomainSaving = false;
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
				loginWelcomeText: ssoLoginWelcomeText || null
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
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/sso`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!r.ok) {
				const d = await r.json();
				throw new Error(d.message || 'Failed to save SSO config');
			}
			toasts.add({ title: 'SSO configuration saved', color: 'success' });
			ssoOidcClientSecret = '';
			ssoSamlCertificate = '';
			await fetchSsoConfig();
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to save',
				color: 'error'
			});
		} finally {
			ssoSaving = false;
		}
	}

	async function testSsoConnection() {
		if (!organization) return;
		ssoTesting = true;
		ssoTestResult = null;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/sso/test`, {
				method: 'POST'
			});
			ssoTestResult = await r.json();
		} catch {
			ssoTestResult = { success: false, error: 'Failed to test connection' };
		} finally {
			ssoTesting = false;
		}
	}

	async function deleteSsoConfig() {
		if (!organization || ssoDeleting) return;
		ssoDeleting = true;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/sso`, { method: 'DELETE' });
			if (!r.ok) throw new Error('Failed to delete');
			toasts.add({ title: 'SSO configuration deleted', color: 'success' });
			ssoConfig = null;
			ssoEnabled = false;
			ssoEnforced = false;
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to delete',
				color: 'error'
			});
		} finally {
			ssoDeleting = false;
		}
	}

	async function fetchScimTokens() {
		if (!organization) return;
		scimLoading = true;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/scim/tokens`);
			if (r.ok) {
				const d = await r.json();
				scimBaseUrl = d.baseUrl || '';
				scimTokens = d.tokens || [];
			}
		} catch (e) {
			console.error('Failed to fetch SCIM tokens:', e);
		} finally {
			scimLoading = false;
		}
	}

	async function createScimToken() {
		if (!organization || !scimNewName.trim()) return;
		scimCreating = true;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/scim/tokens`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: scimNewName.trim() })
			});
			if (!r.ok) {
				const d = await r.json().catch(() => ({}));
				throw new Error(d.message || d.detail || 'Failed to create token');
			}
			const d = await r.json();
			scimCreatedToken = { name: d.name, token: d.token };
			if (d.baseUrl) scimBaseUrl = d.baseUrl;
			scimTokens = [
				{
					id: d.id,
					name: d.name,
					lastUsedAt: null,
					expiresAt: d.expiresAt ?? null,
					createdAt: d.createdAt
				},
				...scimTokens
			];
			scimNewName = '';
			toasts.add({ title: 'SCIM token created', color: 'success' });
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to create token',
				color: 'error'
			});
		} finally {
			scimCreating = false;
		}
	}

	async function revokeScimToken(tokenId: string) {
		if (!organization || scimRevokingId) return;
		if (
			!confirm(
				'Revoke this SCIM token? Provisioning from your identity provider will stop working immediately.'
			)
		)
			return;
		scimRevokingId = tokenId;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/scim/tokens/${tokenId}`, {
				method: 'DELETE'
			});
			if (!r.ok) {
				const d = await r.json().catch(() => ({}));
				throw new Error(d.message || d.detail || 'Failed to revoke token');
			}
			toasts.add({ title: 'SCIM token revoked', color: 'success' });
			scimTokens = scimTokens.filter((t) => t.id !== tokenId);
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to revoke token',
				color: 'error'
			});
		} finally {
			scimRevokingId = null;
		}
	}

	onMount(() => {
		fetchOrganization();
	});

	let orgEventsUnsub: (() => void) | null = null;
	let membersRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	let subscribedOrgId: string | null = null;
	$effect(() => {
		const id = organization?.id ?? null;
		if (!id || id === subscribedOrgId) return;
		subscribedOrgId = id;
		orgEventsUnsub?.();
		orgEventsUnsub = subscribeOrgEvents(id, (ev) => {
			if (ev.type !== 'membership.changed') return;
			if (membersRefreshTimer) return;
			membersRefreshTimer = setTimeout(() => {
				membersRefreshTimer = null;
				fetchOrganization();
			}, 500);
		});
	});

	onDestroy(() => {
		orgEventsUnsub?.();
		if (membersRefreshTimer) clearTimeout(membersRefreshTimer);
	});
</script>

{#if error}
	<div class="osp-page"><div class="alert alert-error">{error}</div></div>
{/if}

{#if loading}
	<div class="osp-page">
		<div class="osp-loading">
			<Loader2 class="h-6 w-6 animate-spin text-primary-600" />
		</div>
	</div>
{:else if organization}
	<div class="osp-page">
		<div class="osp-stack">
			{#if activeTab === 'general'}
				<OrgGeneralTab
					{organization}
					{organizationSlug}
					{currentUserRole}
					{canEditOrg}
					bind:isEditing
					bind:editingName
					bind:editingDescription
					{updating}
					{uploadingAvatar}
					{deletingAvatar}
					onStartEditing={startEditing}
					onCancelEditing={cancelEditing}
					onSave={saveOrganization}
					onUploadAvatar={uploadAvatar}
					onDeleteAvatar={deleteAvatar}
					bind:avatarInputRef={avatarInput}
				/>
			{/if}
			{#if activeTab === 'members'}
				<OrgMembersTab
					{members}
					{invitations}
					{canInvite}
					{isOwner}
					bind:newMemberEmail
					bind:newMemberRole
					{addingMember}
					{resendingInvitationId}
					{cancellingInvitationId}
					{removingMemberId}
					onAddMember={addMember}
					onRemoveMember={requestRemoveMember}
					onUpdateMemberRole={updateMemberRole}
					onResendInvitation={resendInvitation}
					onCancelInvitation={cancelInvitation}
				/>
			{/if}
			{#if activeTab === 'database'}
				<OrgDatabaseTab {canEditOrg} bind:publicIp {publicIpSaving} onSavePublicIp={savePublicIp} />
			{/if}
			{#if activeTab === 'backups'}
				<OrgBackupsTab
					{canEditOrg}
					{isOwner}
					{backupLoading}
					{backupSaving}
					{backupConfigured}
					bind:backupEditMode
					bind:backupEndpoint
					bind:backupBucket
					bind:backupRegion
					bind:backupAccessKey
					bind:backupSecretKey
					{backupAccessKeyConfigured}
					{backupAccessKeyLast4}
					{backupSecretConfigured}
					onSaveBackupSettings={saveBackupSettings}
					onClearBackupSettings={clearBackupSettings}
					onCancelEdit={() => {
						backupEditMode = false;
						backupSecretKey = '';
						fetchBackupSettings();
					}}
				/>
			{/if}
			{#if activeTab === 'notifications' && $notificationsEnabled}
				<OrgNotificationsTab
					{canEditOrg}
					loading={notifLoading}
					channels={notifChannels}
					projects={notifProjects}
					saving={notifSaving}
					deletingId={notifDeletingId}
					testingId={notifTestingId}
					togglingId={notifTogglingId}
					createdSecret={notifCreatedSecret}
					onDismissSecret={() => {
						notifCreatedSecret = null;
					}}
					onSaveChannel={saveNotificationChannel}
					onDeleteChannel={(channel) => {
						channelToDelete = channel;
						showDeleteChannelModal = true;
					}}
					onTestChannel={testNotificationChannel}
					onToggleChannel={toggleNotificationChannel}
				/>
			{/if}
			{#if activeTab === 'sso' && isEnterprise}
				<OrgSsoTab
					{organization}
					{isOwner}
					{baseDomain}
					{ssoLoading}
					{ssoSaving}
					bind:ssoTab
					{ssoConfig}
					bind:ssoSubdomain
					{ssoSubdomainSaving}
					bind:ssoProvider
					bind:ssoOidcIssuerUrl
					bind:ssoOidcClientId
					bind:ssoOidcClientSecret
					bind:ssoOidcScopes
					bind:ssoSamlEntryPoint
					bind:ssoSamlIssuer
					bind:ssoSamlCertificate
					bind:ssoSamlMetadataUrl
					bind:ssoEnabled
					bind:ssoEnforced
					bind:ssoLoginLogoUrl
					bind:ssoLoginPrimaryColor
					bind:ssoLoginBgColor
					bind:ssoLoginWelcomeText
					{ssoTestResult}
					{ssoTesting}
					{ssoDeleting}
					onSaveSubdomain={saveSubdomain}
					onSaveSsoConfig={saveSsoConfig}
					onTestSsoConnection={testSsoConnection}
					onDeleteSsoConfig={() => (showDeleteSsoModal = true)}
				/>
			{/if}
			{#if activeTab === 'scim' && isEnterprise}
				<OrgScimTab
					{isOwner}
					{scimLoading}
					{scimBaseUrl}
					{scimTokens}
					bind:scimNewName
					{scimCreating}
					{scimRevokingId}
					{scimCreatedToken}
					onCreateToken={createScimToken}
					onRevokeToken={revokeScimToken}
					onDismissCreatedToken={() => {
						scimCreatedToken = null;
					}}
				/>
			{/if}
		</div>
	</div>
{/if}

<ConfirmModal
	bind:open={showRemoveMemberModal}
	title="Remove member"
	description={memberToRemove
		? `Remove ${memberDisplayName(memberToRemove)} from the organization?`
		: ''}
	confirmLabel="Remove"
	onconfirm={() => {
		if (memberToRemove) removeMember(memberToRemove.id);
	}}
	oncancel={() => {}}
/>

<ConfirmModal
	bind:open={showDeleteChannelModal}
	title="Delete notification channel"
	description={channelToDelete
		? `Delete "${channelToDelete.name}"? Notifications to this destination will stop immediately.`
		: ''}
	confirmLabel="Delete channel"
	onconfirm={() => {
		if (channelToDelete) deleteNotificationChannel(channelToDelete.id);
	}}
	oncancel={() => {}}
/>

<ConfirmModal
	bind:open={showDeleteSsoModal}
	title="Delete SSO configuration?"
	description="This <strong>disables SSO login</strong> for the organization. Members who sign in through your identity provider will no longer be able to log in with it."
	html
	confirmLabel="Delete SSO config"
	onconfirm={deleteSsoConfig}
	oncancel={() => {}}
/>

<style>
	.osp-page {
		padding: 2.5rem 2.5rem 3rem;
		max-width: 52rem;
		margin: 0 auto;
	}
	.osp-stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.osp-loading {
		display: flex;
		justify-content: center;
		padding: 4rem 0;
	}
	@media (max-width: 640px) {
		.osp-page {
			padding: 1.5rem 1rem 3rem;
		}
	}
</style>
