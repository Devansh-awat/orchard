import { writable } from 'svelte/store';

export interface TreeItem {
	id: string;
	name: string;
	type: 'project' | 'deployment' | 'ingress' | 'database' | 'templateInstance';
	href: string;
	children?: TreeItem[];
}

// Tree store is no longer auto-fetched — the sidebar tree was removed.
// QuickSearch still reads $tree; it will be empty until a future migration
// feeds it from the overview TanStack Query cache.
const treeData = writable<TreeItem[]>([]);
const loading = writable(false);
const error = writable<string | null>(null);

export const tree = treeData;
export const treeLoading = loading;
export const treeError = error;

/** No-op — kept so call sites don't need to be touched yet. */
export const refreshTree = () => {};
