import type { ParamMatcher } from '@sveltejs/kit';
import { graftRegistry, isAdminScreenOf } from '$lib/grafts/registry';

export const match: ParamMatcher = (param) =>
	graftRegistry().some(
		(g) => g.id === param && g.screens.some((s) => isAdminScreenOf(g.id, s.path))
	);
