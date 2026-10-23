import type { StatusMeta } from '$lib/components/ui/status';

export type BuildItem = {
	id: string;
	app: string;
	kind?: 'deployment' | 'database' | 'job';
	icon?: string | null;
	message: string;
	status: StatusMeta;
	at: string;
	href: string;
	branch?: string;
	duration?: string;
	progress?: number;
	image?: string | null;
};
