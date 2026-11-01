export type SpotlightItem = {
	id: string;
	name: string;
	description?: string | null;
	href: string;
	url?: string | null;
	image?: string | null;
	background?: string | null;
	owner?: string;
	status: string;
	tone: 'success' | 'progress' | 'error' | 'neutral';
	apps?: { name: string; kind?: 'deployment' | 'database' | 'job' }[];
};
