import type { ParamMatcher } from '@sveltejs/kit';
import { graftRoots } from '$lib/grafts/registry';

const RESERVED_SLUGS = new Set(['admin', 'user', 'oauth', 'invite', 'sandboxes', 'status']);

export const match: ParamMatcher = (param) =>
	!RESERVED_SLUGS.has(param) && !graftRoots().has(param);
