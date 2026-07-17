import { statusMeta, type StatusMeta } from '$lib/components/ui';
import { apiFetch } from '$lib/stores';

export interface GroveCategory {
	id: string;
	slug: string;
	name: string;
	emoji: string;
	description: string | null;
	threadCount: number;
}

export interface GroveAuthor {
	id: string;
	username: string;
	imageUrl: string | null;
}

export interface GroveThread {
	id: string;
	number: number;
	title: string;
	snippet: string;
	status: string;
	priority: string;
	scope: string;
	images: string[];
	pinned: boolean;
	locked: boolean;
	createdAt: string;
	lastActivityAt: string;
	author: GroveAuthor;
	category: { slug: string; name: string; emoji: string };
	replyCount: number;
	votes: number;
	myVote: boolean;
}

export interface GroveReply {
	id: string;
	body: string;
	images: string[];
	createdAt: string;
	author: GroveAuthor;
}

export const GROVE_STATUSES = [
	'open',
	'acknowledged',
	'will-fix',
	'in-progress',
	'fixed',
	'wont-fix'
] as const;

export const GROVE_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;

export const GROVE_SCOPES = [
	{ value: 'platform', label: 'Main platform' },
	{ value: 'cli', label: 'CLI' },
	{ value: 'mcp', label: 'MCP' },
	{ value: 'other', label: 'Other' }
] as const;

export function scopeLabel(scope: string): string {
	return GROVE_SCOPES.find((s) => s.value === scope)?.label ?? scope;
}

export function groveStatus(status: string): StatusMeta {
	switch (status) {
		case 'acknowledged':
			return statusMeta('neutral', 'Acknowledged');
		case 'will-fix':
			return statusMeta('warning', 'Will fix');
		case 'in-progress':
			return statusMeta('progress', 'In progress', true);
		case 'fixed':
			return statusMeta('success', 'Fixed');
		case 'wont-fix':
			return statusMeta('error', "Won't fix");
		default:
			return statusMeta('info', 'Open');
	}
}

export function grovePriority(priority: string): StatusMeta | null {
	switch (priority) {
		case 'low':
			return statusMeta('neutral', 'Low');
		case 'medium':
			return statusMeta('info', 'Medium');
		case 'high':
			return statusMeta('warning', 'High');
		case 'urgent':
			return statusMeta('error', 'Urgent');
		default:
			return null;
	}
}

export async function uploadGroveImage(file: File): Promise<string> {
	const form = new FormData();
	form.append('file', file);
	const res = await apiFetch('/apiv1/forum/uploads', { method: 'POST', body: form });
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data?.message || 'Upload failed');
	}
	const data = await res.json();
	return data.url;
}
