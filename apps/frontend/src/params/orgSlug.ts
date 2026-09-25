import type { ParamMatcher } from '@sveltejs/kit';

const RESERVED_SLUGS = new Set(['admin', 'user', 'oauth', 'invite', 'sandboxes', 'status']);

export const match: ParamMatcher = (param) => !RESERVED_SLUGS.has(param);
