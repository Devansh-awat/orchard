<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import { apiFetch, toasts, subscribeOrgEvents, earlyAccessFlag } from '$lib/stores';
	import GraftMount from '$lib/grafts/GraftMount.svelte';
	import { graftHost } from '$lib/grafts/host.svelte';
	import { env } from '$env/dynamic/public';
	import AuditLogList from '$lib/components/AuditLogList.svelte';
	import RegistryCredentials from '$lib/components/project/RegistryCredentials.svelte';
	import { Alert, SectionCard, Skeleton } from '$lib/components/ui';
	import SettingsShell from '$lib/components/patterns/SettingsShell.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import LeaveOrganizationButton from '$lib/components/org-settings/LeaveOrganizationButton.svelte';
	import InviteLinkModal from '$lib/components/InviteLinkModal.svelte';
	import {
		OrgMembersTab,
		OrgDatabaseTab,
		OrgBackupsTab,
		OrgSsoTab,
		OrgStatusTab,
		OrgScimTab,
		OrgNotificationsTab,
		OrgHero
	} from '$lib/components/org-settings';
	import type {
		NotificationChannel,
		ChannelPayload
	} from '$lib/components/org-settings/notification-types';

	interface Member {
		id: string;
		role: 'owner' | 'admin' | 'member' | 'guest';
		status?: 'active' | 'disabled';
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
		delivery?: 'email' | 'link';
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

	let newMemberEmail = $state('');
	let newMemberRole = $state<'member' | 'admin' | 'owner'>('member');
	let addingMember = $state(false);

	let resendingInvitationId = $state<string | null>(null);
	let inviteLinks = $state<{ email: string; link: string }[]>([]);
	let reissuedLink = $state(false);
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
	let instanceDefaultPublicIp = $state<string | null>(null);

	let notifLoading = $state(false);
	let notifChannels = $state<NotificationChannel[]>([]);
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

	const notificationsEnabled = earlyAccessFlag('notifications');
	const organizationSlug = $derived($page.params.orgSlug);
	const activeTab = $derived($page.url.searchParams.get('tab') || 'members');
	const canEditOrg = $derived(currentUserRole === 'owner' || currentUserRole === 'admin');
	const canInvite = $derived(currentUserRole === 'owner' || currentUserRole === 'admin');
	const isOwner = $derived(currentUserRole === 'owner');

	let revokingAccessId = $state<string | null>(null);

	async function revokeProjectAccess(projectId: string, projectMemberId: string) {
		if (revokingAccessId) return;
		revokingAccessId = projectMemberId;
		try {
			const res = await apiFetch(`/apiv1/projects/${projectId}/members/${projectMemberId}`, {
				method: 'DELETE'
			});
			if (res.ok) {
				toasts.add({ title: 'Access revoked', color: 'success' });
				await fetchOrganization();
			} else {
				const body = await res.json().catch(() => null);
				toasts.add({ title: body?.message || "Couldn't revoke access", color: 'error' });
			}
		} catch {
			toasts.add({ title: "Couldn't revoke access", color: 'error' });
		} finally {
			revokingAccessId = null;
		}
	}

	const graftProps = $derived(
		organization ? { orgId: organization.id, orgSlug: organizationSlug } : null
	);
	const graftTabs = $derived(
		graftProps
			? graftHost.slot('org.settings.tabs', graftProps).map(({ graftId, host, item }) => ({
					key: `graft-${graftId}-${item.id}`,
					graftId,
					host,
					label: item.label,
					mount: item.mount
				}))
			: []
	);
	const activeGraftTab = $derived(graftTabs.find((t) => t.key === activeTab));

	const SETTINGS_RAIL = $derived(
		[
			{
				label: 'Organization',
				items: [
					{ id: 'members', label: 'Members', href: `/${organizationSlug}/settings?tab=members` }
				]
			},
			{
				label: 'Platform',
				items: [
					{
						id: 'database',
						label: 'Database defaults',
						href: `/${organizationSlug}/settings?tab=database`
					},
					{
						id: 'registries',
						label: 'Registry credentials',
						href: `/${organizationSlug}/settings?tab=registries`
					},
					{ id: 'backups', label: 'Backups', href: `/${organizationSlug}/settings?tab=backups` },
					{ id: 'status', label: 'Status page', href: `/${organizationSlug}/settings?tab=status` },
					...($notificationsEnabled
						? [
								{
									id: 'notifications',
									label: 'Notifications',
									href: `/${organizationSlug}/settings?tab=notifications`
								}
							]
						: [])
				]
			},
			{
				label: 'Access',
				items: [
					{ id: 'sso', label: 'SSO', href: `/${organizationSlug}/settings?tab=sso` },
					{ id: 'scim', label: 'SCIM', href: `/${organizationSlug}/settings?tab=scim` }
				]
			},
			{
				label: 'Extensions',
				items: graftTabs.map((t) => ({
					id: t.key,
					label: t.label,
					href: `/${organizationSlug}/settings?tab=${t.key}`
				}))
			},
			{
				label: 'Activity',
				items: [
					{ id: 'usage', label: 'Usage', href: `/${organizationSlug}/usage` },
					{ id: 'audit', label: 'Audit log', href: `/${organizationSlug}/settings?tab=audit` }
				]
			}
		].filter((g) => g.items.length > 0)
	);
	const baseDomain = env.PUBLIC_BASE_DOMAIN ?? '';
	const backupConfigured = $derived(
		Boolean(backupEndpoint && backupBucket && backupSecretConfigured)
	);

	async function fetchOrganization() {
		if (!organization) loading = true;
		error = null;
		try {
			const response = await apiFetch(`/apiv1/organizations/slug/${organizationSlug}`);
			if (!response.ok) throw new Error("Couldn't load organization");
			const data = await response.json();
			organization = data;
			members = data.members || [];
			const roleResponse = await apiFetch(`/apiv1/organizations/${data.id}/members/me`);
			if (roleResponse.ok) {
				const roleData = await roleResponse.json();
				currentUserRole = roleData.role;
				if (roleData.role === 'owner' || roleData.role === 'admin') {
					// The slug payload omits per-member project access; the members
					// endpoint inlines it for admins so the table can show + revoke.
					try {
						const mRes = await apiFetch(`/apiv1/organizations/${data.id}/members`);
						if (mRes.ok) members = await mRes.json();
					} catch {
						/* keep the slug payload's members */
					}
					await fetchInvitations();
					await fetchBackupSettings();
					await fetchNotificationChannels();
					if (roleData.role === 'owner') {
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
			error = e instanceof Error ? e.message : "Couldn't load organization";
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
			instanceDefaultPublicIp = d.instanceDefaultPublicIp || null;
		} finally {
			backupLoading = false;
		}
	}

	async function fetchNotificationChannels() {
		if (!organization) return;
		notifLoading = true;
		try {
			const channelsRes = await apiFetch(
				`/apiv1/organizations/${organization.id}/notification-channels`
			);
			if (channelsRes.ok) notifChannels = await channelsRes.json();
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
				throw new Error(d.message || "Couldn't save channel");
			}
			if (d.webhookSecret) notifCreatedSecret = d.webhookSecret;
			toasts.add({ title: channelId ? 'Channel updated' : 'Channel added', color: 'success' });
			await fetchNotificationChannels();
			return true;
		} catch (e) {
			toasts.add({
				title: "Couldn't save channel",
				description: e instanceof Error ? e.message : "Couldn't save channel",
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
			if (!r.ok) throw new Error("Couldn't delete channel");
			toasts.add({ title: 'Channel deleted', color: 'success' });
			notifChannels = notifChannels.filter((c) => c.id !== channelId);
		} catch (e) {
			toasts.add({
				title: "Couldn't delete channel",
				description: e instanceof Error ? e.message : "Couldn't delete channel",
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
			if (!r.ok) throw new Error("Couldn't update channel");
			const updated = await r.json();
			notifChannels = notifChannels.map((c) =>
				c.id === channelId ? { ...c, enabled: updated.enabled } : c
			);
		} catch (e) {
			toasts.add({
				title: "Couldn't update channel",
				description: e instanceof Error ? e.message : "Couldn't update channel",
				color: 'error'
			});
		} finally {
			notifTogglingId = null;
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
				throw new Error(d.message || "Couldn't update organization");
			}
			toasts.add({ title: 'Organization updated', color: 'success' });
			isEditing = false;
			fetchOrganization();
		} catch (e) {
			toasts.add({
				title: "Couldn't update",
				description: e instanceof Error ? e.message : "Couldn't update",
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
				description: 'Use a JPEG, PNG, GIF or WebP image',
				color: 'error'
			});
			return;
		}
		if (file.size > 5 * 1024 * 1024) {
			toasts.add({
				title: 'File too large',
				description: 'Use a file under 5 MB',
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
			if (!r.ok) throw new Error("Couldn't upload avatar");
			toasts.add({ title: 'Avatar updated', color: 'success' });
			fetchOrganization();
		} catch (e) {
			toasts.add({
				title: "Couldn't upload avatar",
				description: e instanceof Error ? e.message : "Couldn't upload avatar",
				color: 'error'
			});
		} finally {
			uploadingAvatar = false;
		}
	}

	async function deleteAvatar() {
		if (!organization || !canEditOrg) return;
		deletingAvatar = true;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/avatar`, {
				method: 'DELETE'
			});
			if (!r.ok) throw new Error("Couldn't delete avatar");
			toasts.add({ title: 'Avatar removed', color: 'success' });
			fetchOrganization();
		} catch (e) {
			toasts.add({
				title: "Couldn't delete avatar",
				description: e instanceof Error ? e.message : "Couldn't delete avatar",
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
				throw new Error(d.message || "Couldn't add member");
			}
			const invitation = await r.json().catch(() => ({}));
			if (invitation.inviteLink) {
				inviteLinks = [{ email: invitation.email, link: invitation.inviteLink }];
				reissuedLink = false;
				toasts.add({ title: 'Invitation created', color: 'success' });
			} else {
				toasts.add({ title: `Invitation sent to ${invitation.email}`, color: 'success' });
			}
			newMemberEmail = '';
			newMemberRole = 'member';
			await fetchOrganization();
		} catch (e) {
			toasts.add({
				title: "Couldn't add member",
				description: e instanceof Error ? e.message : "Couldn't add member",
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
		if (member.status === 'disabled') {
			void enableMember(memberId);
			return;
		}
		memberToRemove = member;
		showRemoveMemberModal = true;
	}

	async function enableMember(memberId: string) {
		if (!organization || removingMemberId) return;
		removingMemberId = memberId;
		try {
			const r = await apiFetch(
				`/apiv1/organizations/${organization.id}/members/${memberId}/enable`,
				{ method: 'POST' }
			);
			if (!r.ok) {
				const d = await r.json().catch(() => ({}));
				throw new Error(d.message || "Couldn't turn access back on");
			}
			toasts.add({ title: 'Access turned back on', color: 'success' });
			fetchOrganization();
		} catch (e) {
			toasts.add({
				title: "Couldn't turn access back on",
				description: e instanceof Error ? e.message : "Couldn't turn access back on",
				color: 'error'
			});
		} finally {
			removingMemberId = null;
		}
	}

	async function removeMember(memberId: string) {
		if (!organization || removingMemberId) return;
		removingMemberId = memberId;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/members/${memberId}`, {
				method: 'DELETE'
			});
			if (!r.ok) {
				const d = await r.json().catch(() => ({}));
				throw new Error(d.message || "Couldn't turn off access");
			}
			toasts.add({ title: 'Access turned off', color: 'success' });
			fetchOrganization();
		} catch (e) {
			toasts.add({
				title: "Couldn't turn off access",
				description: e instanceof Error ? e.message : "Couldn't turn off access",
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
			if (!r.ok) {
				const d = await r.json().catch(() => ({}));
				throw new Error(d.message || "Couldn't update member role");
			}
			toasts.add({ title: 'Role updated', color: 'success' });
			fetchOrganization();
		} catch (e) {
			toasts.add({
				title: "Couldn't update role",
				description: e instanceof Error ? e.message : "Couldn't update role",
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
				throw new Error(d.message || "Couldn't resend invitation");
			}
			await fetchOrganization();
			toasts.add({ title: 'Invitation resent', color: 'success' });
		} catch (e) {
			toasts.add({
				title: "Couldn't resend invitation",
				description: e instanceof Error ? e.message : "Couldn't resend invitation",
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
				throw new Error(d.message || "Couldn't cancel invitation");
			}
			toasts.add({ title: 'Invitation canceled', color: 'success' });
			invitations = invitations.filter((inv) => inv.id !== invitationId);
		} catch (e) {
			toasts.add({
				title: "Couldn't cancel invitation",
				description: e instanceof Error ? e.message : "Couldn't cancel invitation",
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
				throw new Error(d.message || "Couldn't save");
			}
			toasts.add({
				title: publicIp.trim() ? 'Public IP saved' : 'Public IP cleared',
				color: 'success'
			});
			await fetchBackupSettings();
		} catch (e) {
			toasts.add({
				title: "Couldn't save",
				description: e instanceof Error ? e.message : "Couldn't save",
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
				throw new Error(d.message || "Couldn't save");
			}
			toasts.add({ title: 'Backup settings saved', color: 'success' });
			backupSecretKey = '';
			backupEditMode = false;
			await fetchBackupSettings();
		} catch (e) {
			toasts.add({
				title: "Couldn't save",
				description: e instanceof Error ? e.message : "Couldn't save",
				color: 'error'
			});
		} finally {
			backupSaving = false;
		}
	}

	let confirmClearBackups = $state(false);
	let scimRevokeTarget = $state<string | null>(null);
	let confirmRevokeScim = $state(false);

	function clearBackupSettings() {
		if (!organization) return;
		confirmClearBackups = true;
	}

	async function performClearBackupSettings() {
		if (!organization) return;
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
			if (!r.ok) throw new Error("Couldn't clear");
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
				title: "Couldn't clear",
				description: e instanceof Error ? e.message : "Couldn't clear",
				color: 'error'
			});
		} finally {
			backupSaving = false;
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
				throw new Error(d.message || d.detail || "Couldn't create token");
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
				title: "Couldn't create token",
				description: e instanceof Error ? e.message : "Couldn't create token",
				color: 'error'
			});
		} finally {
			scimCreating = false;
		}
	}

	function revokeScimToken(tokenId: string) {
		if (!organization || scimRevokingId) return;
		scimRevokeTarget = tokenId;
		confirmRevokeScim = true;
	}

	async function performRevokeScimToken(tokenId: string) {
		if (!organization || scimRevokingId) return;
		scimRevokingId = tokenId;
		try {
			const r = await apiFetch(`/apiv1/organizations/${organization.id}/scim/tokens/${tokenId}`, {
				method: 'DELETE'
			});
			if (!r.ok) {
				const d = await r.json().catch(() => ({}));
				throw new Error(d.message || d.detail || "Couldn't revoke token");
			}
			toasts.add({ title: 'SCIM token revoked', color: 'success' });
			scimTokens = scimTokens.filter((t) => t.id !== tokenId);
		} catch (e) {
			toasts.add({
				title: "Couldn't revoke token",
				description: e instanceof Error ? e.message : "Couldn't revoke token",
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
	<div class="osp-state"><Alert tone="error">{error}</Alert></div>
{/if}

{#if loading}
	<div class="osp-state">
		<Skeleton height="6rem" rounded="var(--radius-widget)" />
		<Skeleton height="20rem" rounded="var(--radius-widget)" />
	</div>
{:else if organization}
	<SettingsShell
		crumbs={[{ label: 'Home', href: `/${organizationSlug}` }, { label: 'Settings' }]}
		groups={SETTINGS_RAIL}
		activeId={activeTab}
		label="Organization settings sections"
	>
		{#snippet header()}
			<OrgHero
				{organization}
				{organizationSlug}
				{currentUserRole}
				{canEditOrg}
				pendingInvites={invitations.length}
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
			/>
		{/snippet}

		{#if activeGraftTab && graftProps}
			{#key activeGraftTab.key}
				<GraftMount
					graftId={activeGraftTab.graftId}
					mount={activeGraftTab.mount}
					props={graftProps}
					host={activeGraftTab.host}
				/>
			{/key}
		{/if}
		{#if activeTab === 'audit'}
			<AuditLogList scope={{ organizationId: organization.id }} />
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
				{organizationSlug}
				{revokingAccessId}
				onRevokeProjectAccess={revokeProjectAccess}
				onAddMember={addMember}
				onRemoveMember={requestRemoveMember}
				onUpdateMemberRole={updateMemberRole}
				onResendInvitation={resendInvitation}
				onCancelInvitation={cancelInvitation}
			/>
			<InviteLinkModal bind:links={inviteLinks} reissued={reissuedLink} />
			{#if currentUserRole && currentUserRole !== 'owner' && organization}
				<SectionCard
					title="Leave organization"
					description="You lose access to its projects. Your account and your other organizations stay as they are."
				>
					<LeaveOrganizationButton {organization} />
				</SectionCard>
			{/if}
		{/if}
		{#if activeTab === 'registries' && canEditOrg}
			{#key organization.id}<RegistryCredentials
					organizationId={organization.id}
					canEdit={canEditOrg}
				/>{/key}
		{/if}

		{#if activeTab === 'database'}
			<OrgDatabaseTab
				{canEditOrg}
				bind:publicIp
				{publicIpSaving}
				{instanceDefaultPublicIp}
				onSavePublicIp={savePublicIp}
			/>
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
				organizationId={organization.id}
				loading={notifLoading}
				channels={notifChannels}
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
		{#if activeTab === 'status'}
			<OrgStatusTab {organization} {isOwner} {baseDomain} />
		{/if}
		{#if activeTab === 'sso'}
			<OrgSsoTab {organization} {isOwner} {baseDomain} onOrganizationChanged={fetchOrganization} />
		{/if}
		{#if activeTab === 'scim'}
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
	</SettingsShell>
{/if}

<ConfirmModal
	bind:open={confirmClearBackups}
	title="Clear backup storage?"
	description="Existing backups stay in the bucket, but Orchard takes no new ones until you set up storage again."
	confirmLabel="Clear"
	onconfirm={performClearBackupSettings}
	oncancel={() => {}}
/>

<ConfirmModal
	bind:open={confirmRevokeScim}
	title="Revoke this SCIM token?"
	description="Provisioning from your identity provider stops working right away."
	confirmLabel="Revoke token"
	onconfirm={() => {
		if (scimRevokeTarget) performRevokeScimToken(scimRevokeTarget);
	}}
	oncancel={() => (scimRevokeTarget = null)}
/>

<ConfirmModal
	bind:open={showRemoveMemberModal}
	title="Turn off access"
	description={memberToRemove
		? `${memberDisplayName(memberToRemove)} loses access to this organization and every project in it, and is signed out of it. They stay on the member list so you can turn them back on, and nothing they built is deleted.`
		: ''}
	confirmLabel="Turn off"
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

<style>
	.osp-state {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		max-width: 100rem;
		margin: 0 auto;
		padding: 1.5rem;
	}
</style>
