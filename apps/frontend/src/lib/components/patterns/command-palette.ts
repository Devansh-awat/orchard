import type { StatusMeta } from '$lib/components/ui/status';
import type { Icon } from '$lib/components/ui/types';

export type PaletteItem = {
	id: string;
	label: string;
	sublabel?: string;
	kind: 'project' | 'deployment' | 'database' | 'job';
	icon?: string | null;
	project?: string;
	projectIcon?: string | null;
	status?: StatusMeta;
	href: string;
	url?: string;
};

export type PaletteAction = {
	id: string;
	label: string;
	hint?: string;
	icon: Icon;
	keywords?: string[];
	shortcut?: string;
	run: () => void;
};
