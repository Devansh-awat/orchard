import { apiFetch } from '$lib/stores';
import type {
	ChannelPayload,
	NotificationChannel,
	NotificationRule,
	NotificationScopeType,
	RulePayload,
	ScopeSettings,
	ScopedChannel,
	SettingValue,
	UserDestination,
	UserSettings
} from './types';

async function json<T>(res: Response, fallback: string): Promise<T> {
	const body = await res.json().catch(() => ({}) as any);
	if (!res.ok) throw new Error(body?.message || body?.error || fallback);
	return body as T;
}

export async function fetchChannels(organizationId: string): Promise<NotificationChannel[]> {
	const res = await apiFetch(`/apiv1/organizations/${organizationId}/notification-channels`);
	return json<NotificationChannel[]>(res, 'Could not load notification channels');
}

export async function fetchScopeChannels(
	organizationId: string,
	scopeType: NotificationScopeType,
	scopeId: string | null
): Promise<ScopedChannel[]> {
	const params = new URLSearchParams({ scopeType });
	if (scopeId) params.set('scopeId', scopeId);
	const res = await apiFetch(
		`/apiv1/organizations/${organizationId}/notification-channels?${params}`
	);
	return json<ScopedChannel[]>(res, 'Could not load notification channels');
}

export async function createChannel(
	organizationId: string,
	payload: ChannelPayload
): Promise<NotificationChannel & { webhookSecret?: string }> {
	const res = await apiFetch(`/apiv1/organizations/${organizationId}/notification-channels`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	});
	return json(res, 'Could not create the destination');
}

export async function fetchRules(
	organizationId: string,
	scopeType?: NotificationScopeType,
	scopeId?: string | null
): Promise<NotificationRule[]> {
	const params = new URLSearchParams();
	if (scopeType) params.set('scopeType', scopeType);
	if (scopeId) params.set('scopeId', scopeId);
	const query = params.toString();
	const res = await apiFetch(
		`/apiv1/organizations/${organizationId}/notification-rules${query ? `?${query}` : ''}`
	);
	return json<NotificationRule[]>(res, 'Could not load notification rules');
}

export async function createRule(
	organizationId: string,
	payload: RulePayload
): Promise<NotificationRule> {
	const res = await apiFetch(`/apiv1/organizations/${organizationId}/notification-rules`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	});
	return json<NotificationRule>(res, 'Could not create the rule');
}

export async function updateRule(
	organizationId: string,
	ruleId: string,
	payload: Partial<RulePayload> & { enabled?: boolean }
): Promise<NotificationRule> {
	const res = await apiFetch(
		`/apiv1/organizations/${organizationId}/notification-rules/${ruleId}`,
		{
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		}
	);
	return json<NotificationRule>(res, 'Could not update the rule');
}

export async function deleteRule(organizationId: string, ruleId: string): Promise<void> {
	const res = await apiFetch(
		`/apiv1/organizations/${organizationId}/notification-rules/${ruleId}`,
		{ method: 'DELETE' }
	);
	await json(res, 'Could not delete the rule');
}

export async function replayChannel(
	organizationId: string,
	channelId: string,
	sinceHours: number
): Promise<{ queued: number; message?: string }> {
	const res = await apiFetch(
		`/apiv1/organizations/${organizationId}/notification-channels/${channelId}/replay`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sinceHours })
		}
	);
	return json(res, 'Could not replay to this channel');
}

export async function fetchUserSettings(): Promise<UserSettings> {
	const res = await apiFetch('/apiv1/users/me/notification-settings');
	return json<UserSettings>(res, 'Could not load your notification settings');
}

export async function saveGlobalSettings(
	values: Partial<Record<string, SettingValue>>
): Promise<UserSettings> {
	const res = await apiFetch('/apiv1/users/me/notification-settings', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ values })
	});
	return json<UserSettings>(res, 'Could not save your notification settings');
}

export async function fetchScopeSettings(
	organizationId: string,
	scopeType: NotificationScopeType,
	scopeId: string
): Promise<ScopeSettings> {
	const res = await apiFetch(
		`/apiv1/users/me/notification-settings/${scopeType}/${scopeId}?organizationId=${organizationId}`
	);
	return json<ScopeSettings>(res, 'Could not load your notification settings');
}

// A null value clears the override and hands the category back to the broader
// scope, which is how the "follow my default" option is expressed.
export async function saveScopeSettings(
	organizationId: string,
	scopeType: string,
	scopeId: string,
	values: Partial<Record<string, SettingValue | null>>
): Promise<void> {
	const res = await apiFetch(`/apiv1/users/me/notification-settings/${scopeType}/${scopeId}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ organizationId, values })
	});
	await json(res, 'Could not save your notification settings');
}

// Removing your own override needs no org context and keeps working after the
// project it pointed at is deleted.
export async function clearScopeSettings(
	scopeType: string,
	scopeId: string
): Promise<{ cleared: number }> {
	const res = await apiFetch(`/apiv1/users/me/notification-settings/${scopeType}/${scopeId}`, {
		method: 'DELETE'
	});
	return json(res, 'Could not clear that override');
}

export async function fetchDestinations(): Promise<UserDestination[]> {
	const res = await apiFetch('/apiv1/users/me/notification-destinations');
	return json<UserDestination[]>(res, 'Could not load your delivery methods');
}

export async function addDestination(type: string, url?: string): Promise<UserDestination> {
	const res = await apiFetch('/apiv1/users/me/notification-destinations', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ type, url })
	});
	return json<UserDestination>(res, 'Could not add that delivery method');
}

export async function setDestinationEnabled(id: string, enabled: boolean): Promise<void> {
	const res = await apiFetch(`/apiv1/users/me/notification-destinations/${id}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ enabled })
	});
	await json(res, 'Could not update that delivery method');
}

export async function deleteDestination(id: string): Promise<void> {
	const res = await apiFetch(`/apiv1/users/me/notification-destinations/${id}`, {
		method: 'DELETE'
	});
	await json(res, 'Could not remove that delivery method');
}

export async function testDestination(id: string): Promise<{ success: boolean; error?: string }> {
	const res = await apiFetch(`/apiv1/users/me/notification-destinations/${id}/test`, {
		method: 'POST'
	});
	return json(res, 'Test delivery failed');
}
