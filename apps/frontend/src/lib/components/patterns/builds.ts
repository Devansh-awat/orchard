import type { StatusMeta } from '$lib/components/ui/status';

export type BuildPhaseItem = { id: string; label: string; ms: number; live?: boolean };

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
	stage?: number;
	stages?: string[];
	eta?: string;
	elapsed?: string;
	image?: string | null;
	project?: string;
	projectIcon?: string | null;
	phases?: BuildPhaseItem[];
	startedAt?: string;
};
