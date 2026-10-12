import type { ParamMatcher } from '@sveltejs/kit';
import { graftRoots } from '$lib/grafts/registry';

export const match: ParamMatcher = (param) => graftRoots().has(param);
