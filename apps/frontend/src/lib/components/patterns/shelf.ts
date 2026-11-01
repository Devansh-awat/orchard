export type ShelfTone = 'success' | 'progress' | 'error' | 'neutral';

export type ShelfItem = {
	id: string;
	title: string;
	subtitle?: string;
	description?: string;
	href: string;
	kind?: 'deployment' | 'database' | 'job';
	icon?: string | null;
	background?: string | null;
	status?: string;
	tone?: ShelfTone;
	progress?: number;
	at?: string;
};
