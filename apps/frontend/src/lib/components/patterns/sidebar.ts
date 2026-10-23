import type { StatusMeta } from '$lib/components/ui/status';
import type { Icon } from '$lib/components/ui/types';

export type SidebarItem = {
	label: string;
	href: string;
	icon?: Icon;
	active?: boolean;
	status?: StatusMeta;
};

export type SidebarSection = { label?: string; items: SidebarItem[]; tiles?: boolean };
