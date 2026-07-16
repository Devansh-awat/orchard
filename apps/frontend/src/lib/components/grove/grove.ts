import { statusMeta, type StatusMeta } from '$lib/components/ui';

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
	title: string;
	snippet: string;
	status: string;
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
	createdAt: string;
	author: GroveAuthor;
}

export const GROVE_STATUSES = ['open', 'planned', 'in-progress', 'done', 'declined'] as const;

export function groveStatus(status: string): StatusMeta {
	switch (status) {
		case 'planned':
			return statusMeta('neutral', 'Planned');
		case 'in-progress':
			return statusMeta('progress', 'In progress', true);
		case 'done':
			return statusMeta('success', 'Done');
		case 'declined':
			return statusMeta('error', 'Declined');
		default:
			return statusMeta('info', 'Open');
	}
}
