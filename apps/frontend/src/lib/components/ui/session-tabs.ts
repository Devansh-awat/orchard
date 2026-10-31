import type { Icon } from './types';

export type SessionTab = {
	id: string;
	label: string;
	title?: string;
	icon?: Icon;
	closable?: boolean;
	bell?: boolean;
};
