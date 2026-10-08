import { apiFetch } from '$lib/stores';
import type { GhIssue } from './types';

export type IntegrationProvider = 'github' | 'linear' | 'slack';

export interface LinkedIntegration {
	provider: IntegrationProvider;
	account: string | null;
	linkedAt: string | null;
}

export interface LinearStatus {
	connected: boolean;
	workspaceName: string | null;
}

export class IntegrationError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = 'IntegrationError';
		this.status = status;
	}
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await apiFetch(path, {
		...init,
		headers: init.body ? { 'Content-Type': 'application/json' } : undefined
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { message?: string | string[] } | null;
		const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
		throw new IntegrationError(message || 'Request failed', res.status);
	}
	const text = await res.text();
	return (text ? JSON.parse(text) : undefined) as T;
}

export function linkedIntegrations() {
	return call<{ integrations: LinkedIntegration[] }>('/apiv1/users/me/integrations');
}

export function linkSlack(token: string) {
	return call<{ connected: true; teamId: string }>('/apiv1/integrations/slack/link', {
		method: 'POST',
		body: JSON.stringify({ token })
	});
}

export function unlinkSlack() {
	return call<{ connected: false }>('/apiv1/users/me/integrations/slack', { method: 'DELETE' });
}

export function linearStatus() {
	return call<LinearStatus>('/apiv1/users/me/integrations/linear');
}

export function connectLinear(apiKey: string) {
	return call<LinearStatus>('/apiv1/users/me/integrations/linear', {
		method: 'PUT',
		body: JSON.stringify({ apiKey })
	});
}

export function disconnectLinear() {
	return call<LinearStatus>('/apiv1/users/me/integrations/linear', { method: 'DELETE' });
}

export function linearIssues(q: string) {
	const search = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
	return call<{ connected: boolean; issues: GhIssue[] }>(
		`/apiv1/integrations/linear/issues${search}`
	);
}
