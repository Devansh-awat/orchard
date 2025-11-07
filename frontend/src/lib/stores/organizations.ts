import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';

export interface Organization {
	id: string;
	name: string;
	slug: string;
	description?: string;
	avatarUrl?: string;
	workspaces?: unknown[];
	members?: unknown[];
}

const STORAGE_KEY = 'selectedOrganizationId';

const organizationsList = writable<Organization[]>([]);
const selectedOrg = writable<Organization | null>(null);
const loadingState = writable(false);

function loadSelectedFromStorage() {
	if (!browser) return null;
	return localStorage.getItem(STORAGE_KEY);
}

function saveSelectedToStorage(orgId: string | null) {
	if (!browser) return;
	if (orgId) {
		localStorage.setItem(STORAGE_KEY, orgId);
	} else {
		localStorage.removeItem(STORAGE_KEY);
	}
}

function setSelected(org: Organization | null) {
	selectedOrg.set(org);
	saveSelectedToStorage(org?.id ?? null);
}

function selectById(id: string) {
	const orgs = get(organizationsList);
	const org = orgs.find((o) => o.id === id);
	if (org) {
		setSelected(org);
	}
}

function initializeSelected() {
	const storedId = loadSelectedFromStorage();
	const orgs = get(organizationsList);

	if (storedId) {
		const org = orgs.find((o) => o.id === storedId);
		if (org) {
			selectedOrg.set(org);
			return;
		}
	}

	if (orgs.length > 0) {
		setSelected(orgs[0]);
	}
}

export const organizations = {
	subscribe: organizationsList.subscribe,
	set: organizationsList.set,
	update: organizationsList.update,
	setSelected,
	selectById,
	initializeSelected,
	setLoading: loadingState.set
};

export const selectedOrganization = {
	subscribe: selectedOrg.subscribe
};

export const organizationsLoading = {
	subscribe: loadingState.subscribe
};
