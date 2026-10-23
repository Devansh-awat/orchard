import type { Icon } from './types';

export interface DropdownOption {
	value: string;
	label: string;
	description?: string;
	mono?: boolean;
	icon?: Icon;
	disabled?: boolean;
}
