import type { StatusMeta } from './status';

export type CheckItem = {
	id: string;
	label: string;
	detail?: string | null;
	value?: string | null;
	meta: StatusMeta;
	ratio?: number | null;
	href?: string;
};
