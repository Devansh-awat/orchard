export const SIDEBAR_EXPANDED_W = 276;
export const SIDEBAR_COLLAPSED_W = 72;

export function sidebarWidthPx(collapsed: boolean, mobile: boolean): number {
	if (mobile) return 0;
	return collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_EXPANDED_W;
}
