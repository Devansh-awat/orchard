export type PodFileKind = 'file' | 'dir' | 'symlink' | 'other';

export interface PodFileEntry {
	name: string;
	kind: PodFileKind;
	size: number | null;
	target?: 'file' | 'dir' | null;
}

export function opensAsFolder(entry: PodFileEntry): boolean {
	return entry.kind === 'dir' || (entry.kind === 'symlink' && entry.target === 'dir');
}

export function isDownloadable(entry: PodFileEntry): boolean {
	return entry.kind === 'file' || (entry.kind === 'symlink' && entry.target === 'file');
}

export type PodFileSortKey = 'name' | 'size';

export interface PodFileSort {
	key: PodFileSortKey;
	dir: 'asc' | 'desc';
}

const naturalName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortPodEntries(entries: PodFileEntry[], sort: PodFileSort | null): PodFileEntry[] {
	const folders = entries.filter(opensAsFolder);
	const files = entries.filter((e) => !opensAsFolder(e));
	if (!sort) return [...folders, ...files];
	const direction = sort.dir === 'asc' ? 1 : -1;
	if (sort.key === 'size') {
		return [
			...files.sort(
				(a, b) =>
					direction * ((a.size ?? 0) - (b.size ?? 0)) ||
					direction * naturalName.compare(a.name, b.name)
			),
			...folders.sort((a, b) => direction * naturalName.compare(a.name, b.name))
		];
	}
	return [...entries].sort((a, b) => direction * naturalName.compare(a.name, b.name));
}

export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}
