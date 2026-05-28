import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { apiFetch } from './api';

export interface PendingInvitation {
	id: string;
	token?: string;
	email: string;
	role: 'owner' | 'admin' | 'member' | 'guest';
	expiresAt: string;
	createdAt: string;
	organization: {
		id: string;
		name: string;
		slug: string;
		avatarUrl?: string;
	};
	inviter: {
		firstName?: string;
		lastName?: string;
		username?: string;
		email: string;
	};
}

const pendingInvitationsList = writable<PendingInvitation[]>([]);
const loadingState = writable(false);
const showInvitationsModalState = writable(false);
const showOnboardingModalState = writable(false);
const acceptedOrganization = writable<PendingInvitation['organization'] | null>(null);

async function fetchPending(): Promise<PendingInvitation[]> {
	if (!browser) return [];

	loadingState.set(true);

	try {
		const response = await apiFetch('/apiv1/invitations/pending');
		if (!response.ok) {
			if (response.status === 401) {
				pendingInvitationsList.set([]);
				return [];
			}
			throw new Error('Failed to fetch pending invitations');
		}

		const invitations = await response.json();
		pendingInvitationsList.set(invitations);
		return invitations;
	} catch (e) {
		console.error('Failed to fetch pending invitations:', e);
		pendingInvitationsList.set([]);
		return [];
	} finally {
		loadingState.set(false);
	}
}

async function accept(tokenOrId: string, useId = false): Promise<{ success: boolean; organization?: PendingInvitation['organization'] }> {
	try {
		const url = useId
			? `/apiv1/invitations/by-id/${tokenOrId}/accept`
			: `/apiv1/invitations/${tokenOrId}/accept`;
		const response = await apiFetch(url, {
			method: 'POST'
		});

		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			throw new Error(data?.message || 'Failed to accept invitation');
		}

		const result = await response.json();

		// Remove the accepted invitation from the list
		pendingInvitationsList.update((list) =>
			list.filter((inv) => useId ? inv.id !== tokenOrId : inv.token !== tokenOrId)
		);

		// Set the accepted organization for onboarding
		if (result.organization) {
			acceptedOrganization.set(result.organization);
		}

		return { success: true, organization: result.organization };
	} catch (e) {
		console.error('Failed to accept invitation:', e);
		throw e;
	}
}

async function decline(tokenOrId: string, useId = false): Promise<boolean> {
	try {
		const url = useId
			? `/apiv1/invitations/by-id/${tokenOrId}/decline`
			: `/apiv1/invitations/${tokenOrId}/decline`;
		const response = await apiFetch(url, {
			method: 'POST'
		});

		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			throw new Error(data?.message || 'Failed to decline invitation');
		}

		// Remove the declined invitation from the list
		pendingInvitationsList.update((list) =>
			list.filter((inv) => useId ? inv.id !== tokenOrId : inv.token !== tokenOrId)
		);

		return true;
	} catch (e) {
		console.error('Failed to decline invitation:', e);
		throw e;
	}
}

function showInvitationsModal() {
	showInvitationsModalState.set(true);
}

function hideInvitationsModal() {
	showInvitationsModalState.set(false);
}

function showOnboardingModal() {
	showOnboardingModalState.set(true);
}

function hideOnboardingModal() {
	showOnboardingModalState.set(false);
	acceptedOrganization.set(null);
}

function getInviterName(inviter: PendingInvitation['inviter']): string {
	if (inviter.firstName && inviter.lastName) {
		return `${inviter.firstName} ${inviter.lastName}`;
	}
	if (inviter.firstName) {
		return inviter.firstName;
	}
	if (inviter.username) {
		return inviter.username;
	}
	return inviter.email;
}

export const pendingInvitations = {
	subscribe: pendingInvitationsList.subscribe,
	fetchPending,
	accept,
	decline,
	getInviterName
};

export const invitationsLoading = {
	subscribe: loadingState.subscribe
};

export const showPendingInvitationsModal = {
	subscribe: showInvitationsModalState.subscribe,
	show: showInvitationsModal,
	hide: hideInvitationsModal
};

export const showOnboarding = {
	subscribe: showOnboardingModalState.subscribe,
	show: showOnboardingModal,
	hide: hideOnboardingModal
};

export const lastAcceptedOrganization = {
	subscribe: acceptedOrganization.subscribe
};

