import { apiFetch } from '$lib/stores';

export const SHARE_TOKEN_HEADER = 'X-Orchard-Share-Token';

export interface SharedSession {
	id: string;
	title: string;
	repo: string | null;
	branch: string | null;
	baseBranch: string | null;
	status: 'active' | 'archived';
	prUrl: string | null;
	createdAt: string;
}

export interface ShareView {
	link: {
		id: string;
		sessionId: string | null;
		expiresAt: string | null;
		createdBy: { id: string; name: string; avatarUrl: string | null } | null;
	};
	sandbox: { id: string; name: string; status: string };
	sessions: SharedSession[];
}

export interface ShareMessage {
	id: string;
	role: 'user' | 'assistant';
	text: string;
	truncated: boolean;
	createdAt: string | null;
	author: { id: string; name: string; avatarUrl: string | null } | null;
}

export interface ShareTranscript {
	sessionId: string;
	chatId: string | null;
	title: string;
	messages: ShareMessage[];
}

export interface ShareChanges {
	isRepo: boolean;
	branch: string | null;
	files: { path: string; status: string; additions: number | null; deletions: number | null }[];
}

export type ShareFailure = 'invalid' | 'forbidden' | 'stopped' | 'error';

export class ShareError extends Error {
	readonly kind: ShareFailure;
	readonly status: number;
	constructor(kind: ShareFailure, status: number, message: string) {
		super(message);
		this.name = 'ShareError';
		this.kind = kind;
		this.status = status;
	}
}

let headerSupported: boolean | null = null;

type ErrorBody = { message?: string | string[] } | null;

function messageOf(body: ErrorBody): string {
	return (Array.isArray(body?.message) ? body.message.join(', ') : body?.message) ?? '';
}

function failure(status: number, body: ErrorBody): ShareError {
	const message = messageOf(body);
	if (status === 403) return new ShareError('forbidden', 403, message);
	if (status === 404) return new ShareError('invalid', 404, message);
	if (status === 409 || status === 503) return new ShareError('stopped', status, message);
	return new ShareError('error', status, message || 'Request failed');
}

function routeMissing(status: number, body: ErrorBody): boolean {
	return status === 404 && /^Cannot GET/i.test(messageOf(body));
}

async function shareGet<T>(token: string, rest: string): Promise<T> {
	if (headerSupported !== false) {
		const res = await apiFetch(`/apiv1/share/sandbox${rest}`, {
			headers: { [SHARE_TOKEN_HEADER]: token }
		});
		if (res.ok) {
			headerSupported = true;
			return (await res.json()) as T;
		}
		const body = (await res.json().catch(() => null)) as ErrorBody;
		if (headerSupported === true || !routeMissing(res.status, body)) {
			throw failure(res.status, body);
		}
		headerSupported = false;
	}
	const res = await apiFetch(`/apiv1/share/sandbox/${encodeURIComponent(token)}${rest}`);
	if (!res.ok) throw failure(res.status, (await res.json().catch(() => null)) as ErrorBody);
	return (await res.json()) as T;
}

export function openShare(token: string) {
	return shareGet<ShareView>(token, '');
}

export function shareTranscript(token: string, sid: string, limit = 200) {
	return shareGet<ShareTranscript>(token, `/sessions/${sid}/transcript?limit=${limit}`);
}

export function shareChanges(token: string, sid: string) {
	return shareGet<ShareChanges>(token, `/sessions/${sid}/changes`);
}

export function shareDiff(token: string, sid: string, file: string) {
	return shareGet<{ diff: string; truncated: boolean }>(
		token,
		`/sessions/${sid}/diff?file=${encodeURIComponent(file)}`
	);
}
