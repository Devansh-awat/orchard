import type { StatusMeta } from '$lib/components/ui/status';
import type { Icon } from '$lib/components/ui/types';

export type SidebarItem = {
	label: string;
	href: string;
	icon?: Icon;
	active?: boolean;
	status?: StatusMeta;
	count?: number;
	alert?: boolean;
};

export type SidebarSection = { label?: string; items: SidebarItem[]; tiles?: boolean };

export type FailingApp = {
	label: string;
	href: string;
	reason?: string;
	at?: string;
	kind?: 'deployment' | 'database' | 'job';
	icon?: string | null;
};

export type FailingStyle = 'row' | 'badge' | 'footer';
